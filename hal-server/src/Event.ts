import { Schema } from "effect";

/**
 * One variant per event kind, and each variant is a *codec*, not just a type:
 * its `Encoded` side is the SQLite row exactly as stored (payload as JSON
 * text, discriminated by the `kind` column) and its `Type` side is the domain
 * event (payload parsed and shape-checked). `fromJsonString` declares that the
 * two sides differ by JSON serialisation at that one field, so decode and
 * encode are the two directions through the same schema and the write format
 * cannot drift from the read expectation.
 *
 * Shapes are nouns and the storage direction lives in verbs (`decodeEvent`,
 * `encodeMessagePayload` below).
 */

const BaseEvent = Schema.Struct({
  seq: Schema.Int,
  author: Schema.String,
  at: Schema.Int,
});

const MessageEvent = Schema.Struct({
  ...BaseEvent.fields,
  kind: Schema.Literal("message"),
  payload: Schema.fromJsonString(
    Schema.toCodecJson(Schema.Struct({ text: Schema.String })),
  ),
});

// maybe better to extract out the codec

const Event = Schema.Union([MessageEvent]);

export type Event = typeof Event.Type;
export type EventInput = Omit<Event, "seq" | "at">;

/**
 * Stored row → domain event; forgiving on read.
 */
export const decodeEvent = Schema.decodeUnknownOption(Event);

/**
 * Domain payload > stored row.
 *
 * Handles encoding to JSON text for the "message" Event, payload column.
 *
 * Going through the schema rather than a bare `JSON.stringify` means a value JSON cannot represent
 * fails the encode instead of being silently corrupted on its way to disk.
 */
export const encodeMessagePayload = Schema.encodeOption(
  MessageEvent.fields.payload,
);
