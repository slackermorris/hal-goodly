import type * as Cloudflare from "alchemy/Cloudflare";
import { Option, Schema } from "effect";
import * as Effect from "effect/Effect";
import {
  decodeEvent,
  encodeMessagePayload,
  Event,
  type EventInput,
} from "./Event.ts";
import * as TaggedErrors from "./tagged-errors";

/**
 * The append-only, ordered event log — the spine of the whole system.
 *
 * This module owns the `events` table and nothing else owns any part of it.
 * That exclusivity is the point rather than a tidiness preference: streaming,
 * multiplayer, replay and effort accounting are all projections of this one
 * log, and they only stay consistent with each other while there is exactly
 * one writer.
 *
 * Deliberately ignorant of its host. It knows nothing about Durable Objects,
 * sockets, participants, models or tasks — a `Thread` holds one of these, and
 * the log could not tell you so. Naming it after its owner (`SessionLog`, as
 * it was) was the thing that kept the two concepts blurred; the Cloudflare
 * Agents SDK names its equivalents for the mechanism too — `resumable-stream`,
 * `turn-queue`, `orphan-store` — never for the object that holds them.
 *
 * What an event *is* lives in `Event.ts`; this module only moves events in
 * and out of the table.
 */

/**
 * SQLite caps a row at 2 MB and the Cloudflare Agents SDK writes against 1.8 MB for
 * headroom. The same number applies here: a log that can write a row SQLite
 * will reject is broken from its first append, so the cap is a write gate
 * rather than a runtime surprise.
 */
const ROW_MAX_BYTES = 1_800_000;

/**
 * The log's schema. Two deliberate choices.
 *
 * `AUTOINCREMENT` rather than a bare `INTEGER PRIMARY KEY`. A plain rowid is
 * *reused* once the rows above it are deleted, which would let a cursor handed
 * to a client be matched by a completely different entry later — a silent
 * replay corruption nothing would catch until it mattered. Nothing deletes
 * from this table today, so the guarantee is currently free insurance; it stays
 * because the first deletion path to arrive (retention, compaction in Phase 3,
 * a manual repair) would otherwise reintroduce the hazard quietly.
 *
 * The payload column stays plain JSON text and the only index is the one the
 * log actually queries by. Replay reads by `seq` (the primary key). Nothing
 * else earns an index, so an evolving event kind stays a code change (a new
 * variant in `Event.ts`) rather than a migration.
 */
const migration = `CREATE TABLE IF NOT EXISTS events (
     seq           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind          TEXT    NOT NULL,
     author        TEXT    NOT NULL,
     payload       TEXT    NOT NULL,
     at            INTEGER NOT NULL
   )`;

export const AppendResponseSchema = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
});

/**
 * One shape, because a cursor cannot currently fall out of the log — nothing
 * deletes, so every cursor ever issued is still replayable.
 *
 * This is where compaction used to show up, as a second `Truncated` variant
 * carrying a `floor`. It is gone on purpose. Compaction is a *context window*
 * mechanism, not a storage one — the Agents SDK proves the point by triggering
 * it on a token threshold and writing summaries to a table separate from the
 * messages they summarise — so it belongs to the phase that first has a
 * context window to manage, not to the log's first draft. When it returns, the
 * variant returns with it.
 *
 * `skipped` is how "forgiving on read" becomes assertable — one corrupt row
 * must cost exactly one entry, and that is only provable if the count is part
 * of the result rather than only a log line.
 */
export const ReadResponseSchema = Schema.Struct({
  events: Schema.Array(Event),
  nextCursor: Schema.Number,
  skipped: Schema.Number,
});

const DEFAULT_READ_LIMIT = 256;

/**
 * Bind the log to a SQLite handle and run its migrations.
 *
 * Takes the storage rather than the Durable Object state, so the log has no
 * way to reach an alarm, a socket, or the object's identity even by accident.
 */
export const make = (sql: Cloudflare.Workers.SqlStorage) =>
  Effect.gen(function* () {
    const query = <
      T extends Record<string, string | number | ArrayBuffer | null>,
    >(
      statement: string,
      ...bindings: ReadonlyArray<string | number | null>
    ) =>
      Effect.flatMap(sql.exec<T>(statement, ...bindings), (cursor) =>
        cursor.toArray(),
      );

    yield* sql.exec(migration);

    const append = (input: EventInput) =>
      Effect.gen(function* () {
        const payload = encodeMessagePayload(input.payload);
        if (Option.isNone(payload)) {
          return yield* Effect.die(
            new Error(`unencodable payload for kind ${input.kind}`),
          );
        }

        const bytes = new TextEncoder().encode(payload.value).byteLength;
        if (bytes > ROW_MAX_BYTES) {
          return yield* Effect.fail(
            new TaggedErrors.EntryTooLarge({
              bytes,
              limit: ROW_MAX_BYTES,
            }),
          );
        }

        const at = Date.now();

        const cursor = yield* sql.exec<typeof AppendResponseSchema.Type>(
          `INSERT INTO events (kind, author, payload, at)
             VALUES (?, ?, ?, ?)
             RETURNING seq, at`,
          input.kind,
          input.author,
          payload.value,
          at,
        );

        const row = yield* cursor.one();

        return row;
      });

    const read = (after: number, limit = DEFAULT_READ_LIMIT) =>
      Effect.gen(function* () {
        const rows = yield* query<typeof Event.Encoded>(
          `SELECT seq, kind, author, payload, at
             FROM events
            WHERE seq > ?
            ORDER BY seq
            LIMIT ?`,
          after,
          limit,
        );

        let skipped = 0;
        const events: Array<typeof Event.Type> = [];

        for (const row of rows) {
          const decoded = decodeEvent(row);
          if (Option.isNone(decoded)) {
            skipped += 1;

            yield* Effect.logWarning("dropping undecodable log entry", {
              seq: row.seq,
              kind: row.kind,
            });

            continue;
          }
          events.push(decoded.value);
        }

        console.log("logging out the events", { events });

        // TODO: fix this logic
        const nextCursor = rows[rows.length - 1]?.seq ?? after;

        return ReadResponseSchema.make({ events, nextCursor, skipped });
      });

    /**
     * Entry count, which diverges from `head.seq` the moment anything is ever
     * deleted. Exposed so callers never need to reach into `events` themselves
     * — the table is this module's and stays that way.
     */
    const count = Effect.gen(function* () {
      const [row] = yield* query<{ rows: number }>(
        `SELECT COUNT(*) AS rows FROM events`,
      );
      return row?.rows ?? 0;
    });

    return { append, read, count } as const;
  });
