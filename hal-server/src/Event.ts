import { DateTime, Effect, Schema } from "effect";

// ─── Domain ──────────────────────────────────────────────────────────

const MessagePayload = Schema.Struct({ text: Schema.String }).annotate({
  identifier: "Event.Message.Payload",
});

/**
 * One schema per event kind, and one encoding: `Type` is the domain event,
 * `Encoded` is the SQLite row. Encode to write, decode to read, and the wire
 * shape is derived from the same schema rather than declared — so this is the
 * only place an event's shape is stated.
 *
 * Neither `seq` nor `at` is ever asked of a caller, and they are absent for
 * different reasons: SQLite assigns `seq`, so it is optional — absent on the way
 * in, present on the way out. The log assigns `at`, so it stays a required
 * `Date` on the domain and is filled by the constructor default below.
 */
export const MessageEvent = Schema.Struct({
  seq: Schema.Int.pipe(Schema.optional),
  kind: Schema.Literal("message"),
  author: Schema.String,
  /**
   * `DateFromMillis` rather than `DateTimeUtcFromMillis`: the domain event
   * crosses a Workers RPC boundary, and RPC serializes with structured clone,
   * not JSON. Structured clone has native support for `Date` but not for
   * Effect's `DateTime.Utc` — that combination fails with `DataCloneError`.
   */
  at: Schema.DateFromMillis.pipe(
    Schema.withConstructorDefault(Effect.map(DateTime.now, DateTime.toDateUtc)),
  ),
  payload: Schema.fromJsonString(Schema.toCodecJson(MessagePayload)),
}).annotate({ identifier: "Event.Message" });

export const Event = Schema.Union([MessageEvent])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "Event" });

/** What `append` receives: the event before the log has stamped anything. */
export type EventInput = (typeof MessageEvent)["~type.make.in"];

// ─── Crossings ───────────────────────────────────────────────────────

/** Storage → Domain; forgiving. A malformed row is `Option.none`, one skipped entry. */
export const decodeEvent = Schema.decodeUnknownOption(Event);

/** Domain → Storage. */
export const encodeEvent = (input: EventInput) =>
  Schema.encodeOption(Event)(MessageEvent.make(input));
