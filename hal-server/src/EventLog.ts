import type * as Cloudflare from "alchemy/Cloudflare";
import { Console, Option, Schema } from "effect";
import * as Effect from "effect/Effect";

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
 * The payload stays opaque and the only index is the one the log actually
 * queries by. Replay reads by `seq` (the primary key). Nothing else earns an index,
 * so an evolving event kind stays a code change rather than a migration.
 */
const migration = `CREATE TABLE IF NOT EXISTS events (
     seq           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind          TEXT    NOT NULL,
     author        TEXT    NOT NULL,
     payload       TEXT    NOT NULL,
     at            INTEGER NOT NULL
   )`;

/**
 * Strict on write: an unknown kind is rejected at the boundary rather than
 * persisted, because the log is authoritative and cannot hold garbage. The
 * same literal set is what makes the read path *forgiving* — a row whose kind
 * is no longer recognised fails to decode and costs one entry rather than
 * poisoning the whole replay.
 */
export const EventKind = Schema.Literals(["message"]);

/**
 * A `Schema.Struct` rather than a `Schema.Class`, and the whole public surface
 * below is plain data for the same reason: **everything a Durable Object
 * returns over RPC is structured-cloned, and a class instance is not
 * cloneable.** Decoding through this yields a plain object that survives the
 * boundary; `new Event(...)` would fail at runtime with a `DataCloneError` no
 * typechecker catches.
 */
export const EventSchema = Schema.Struct({
  seq: Schema.Int,
  kind: EventKind,
  author: Schema.String,
  payload: Schema.Unknown,
  at: Schema.Int,
});

export type Event = typeof EventSchema.Type;

export type Receipt = {
  readonly seq: number;
  readonly at: number;
};

export class EntryTooLarge extends Schema.TaggedErrorClass<EntryTooLarge>()(
  "EntryTooLarge",
  {
    bytes: Schema.Int,
    limit: Schema.Int,
  },
) {}

export class UnknownEventKind extends Schema.TaggedErrorClass<UnknownEventKind>()(
  "UnknownEventKind",
  { kind: Schema.String },
) {}

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
export type ReadResult = {
  readonly events: ReadonlyArray<Event>;
  readonly nextCursor: number;
  readonly skipped: number;
};

const decodeEvent = Schema.decodeUnknownOption(EventSchema);
const decodeEventKind = Schema.decodeUnknownOption(EventKind);

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

    // TODO: only allow for kind being a "message",

    // improper use of schema, is it really the eventlogs job to decode it?

    const append = (input: {
      readonly kind: string;
      readonly author: string;
      readonly payload: unknown;
    }) =>
      Effect.gen(function* () {
        const kind = decodeEventKind(input.kind);
        if (Option.isNone(kind)) {
          return yield* Effect.fail(
            new UnknownEventKind({
              _tag: "UnknownEventKind",
              kind: input.kind,
            }),
          );
        }

        // TODO: why we should not use JSON stringify https://dev.to/dzakh/encode-dont-stringify-how-jsonstringify-lies-to-you-38fk

        const payload = JSON.stringify(input.payload ?? null);
        const bytes = new TextEncoder().encode(payload).byteLength;
        if (bytes > ROW_MAX_BYTES) {
          return yield* Effect.fail(
            new EntryTooLarge({
              bytes,
              limit: ROW_MAX_BYTES,
            }),
          );
        }

        const at = Date.now();

        const inserted = yield* query<{ seq: number; at: number }>(
          `INSERT INTO events (kind, author, payload, at)
             VALUES (?, ?, ?, ?)
             RETURNING seq, at`,
          input.kind,
          input.author,
          payload,
          at,
        );

        const row = inserted[0];

        return {
          seq: row.seq,
          at: row.at,
        } satisfies Receipt;
      });

    /** Replay from a cursor. `after` is exclusive. */
    const read = (after: number, limit = DEFAULT_READ_LIMIT) =>
      Effect.gen(function* () {
        const rows = yield* query<{
          seq: number;
          kind: string;
          author: string;
          payload: string;
          at: number;
        }>(
          `SELECT seq, kind, author, payload, at
             FROM events
            WHERE seq > ?
            ORDER BY seq
            LIMIT ?`,
          after,
          limit,
        );

        const events: Array<Event> = [];
        let skipped = 0;

        for (const row of rows) {
          const decoded = decodeRow(row);
          if (decoded === null) {
            skipped += 1;
            /**
             * Skip *and log*. The SDK this borrows from skips silently, and a
             * log that quietly drops an entry during replay is
             * indistinguishable from a cursor bug.
             */
            yield* Effect.logWarning("dropping undecodable log entry", {
              seq: row.seq,
              kind: row.kind,
            });
            continue;
          }
          events.push(decoded);
        }

        const nextCursor = rows[rows.length - 1]?.seq ?? after;

        return { events, nextCursor, skipped } satisfies ReadResult;
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

/**
 * Forgiving on read, at the opposite end of the boundary from the write gate.
 * The write gate keeps garbage out; this stops yesterday's garbage — written
 * before the gate was tight — from making a thread unopenable. The event
 * schema will move during Phase 1, so both are needed at once.
 */
const decodeRow = (row: {
  seq: number;
  kind: string;
  author: string;
  payload: string;
  at: number;
}): Event | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  const decoded = decodeEvent({ ...row, payload });
  if (decoded._tag !== "Some") return null;
  return {
    seq: row.seq,
    // @ts-ignore: I'm working on this.
    kind: row.kind,
    author: row.author,
    payload,
    at: row.at,
  };
};
