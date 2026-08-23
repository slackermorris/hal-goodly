import { Schema } from "effect";

/**
 * The event vocabulary. One rule holds everything together: the *domain*
 * schemas are the only hand-written shapes, and every encoding is a one-line
 * derivation of them — so no boundary's representation can drift from the
 * domain, and a future boundary (the API's wire codec) derives from the same
 * constants.
 *
 * Naming follows Effect's own split: domain shapes are plain nouns
 * (`MessagePayload`, `Event`), codec values carry the `TypeFromEncoded`
 * convention (`MessagePayloadFromJsonString`, like `NumberFromString`), and
 * the storage crossings are verbs (`decodeEvent`, `encodeMessagePayload`).
 */

const BaseEvent = Schema.Struct({
  seq: Schema.Int,
  author: Schema.String,
  at: Schema.Int,
});

/** The domain shape of a message's payload — knows nothing about storage. */
const MessagePayload = Schema.Struct({ text: Schema.String });

/**
 * The storage encoding of that payload, derived: `Type` is still
 * `MessagePayload`, `Encoded` is the JSON text the payload column holds.
 * `toCodecJson` guarantees the intermediate value is lawful JSON (a future
 * BigInt or DateTime field gets its canonical JSON form instead of being
 * mangled by a bare `JSON.stringify`); `fromJsonString` prints it to text.
 */
const MessagePayloadFromJsonString = Schema.fromJsonString(
  Schema.toCodecJson(MessagePayload),
);

/**
 * One variant per event kind, and each variant is a *codec*, not just a type:
 * its `Encoded` side is the SQLite row exactly as stored (payload as JSON
 * text, discriminated by the `kind` column) and its `Type` side is the domain
 * event (payload parsed and shape-checked). Decode and encode are the two
 * directions through the same schema, so the write format cannot drift from
 * the read expectation.
 */
const MessageEvent = Schema.Struct({
  ...BaseEvent.fields,
  kind: Schema.Literal("message"),
  payload: MessagePayloadFromJsonString,
});

const Event = Schema.Union([MessageEvent]);

export type Event = typeof Event.Type;

/**
 * What `append` accepts — the domain event minus `seq` and `at`, which are
 * the log's to assign. Strict on write is the typechecker's job: an internal
 * caller cannot construct an unknown kind or a malformed payload. Input that
 * is genuinely unknown (RPC, HTTP) is decoded at that outer boundary.
 */
export type EventInput = Omit<Event, "seq" | "at">;

/**
 * Stored row → domain event; forgiving on read. Malformed JSON, an
 * unrecognised kind and a shape-drifted payload are all the same failure:
 * `Option.none`, one skipped entry.
 */
export const decodeEvent = Schema.decodeUnknownOption(Event);

/**
 * Domain payload → JSON text for the payload column. Going through the
 * derived codec rather than a bare `JSON.stringify` means a value JSON cannot
 * represent fails the encode instead of being silently corrupted on its way
 * to disk.
 */
export const encodeMessagePayload = Schema.encodeOption(
  MessagePayloadFromJsonString,
);

const PayloadSchema = Schema.Struct({
  payment: Schema.BigInt,
});

const inputPayload = PayloadSchema.make({
  payment: 1000n,
});

const codec = Schema.toCodecJson(PayloadSchema);
const encode = Schema.encodeSync(codec);

const storagePayload = JSON.stringify(encode(inputPayload));
