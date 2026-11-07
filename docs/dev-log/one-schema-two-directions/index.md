---
planted: 2026-08-23
phase: 0
---

# One schema, two directions

The event log stores every payload as JSON text in a SQLite column, which
means every append passes through `JSON.stringify` on its way to disk. The
article [Encode, don't stringify — how JSON.stringify lies to you](https://dev.to/dzakh/encode-dont-stringify-how-jsonstringify-lies-to-you-38fk)
is about why that innocuous call is the least trustworthy step in the
pipeline, and the Effect community's [response to it](https://x.com/GiulioCanti/status/2090409195807903924)
is what the payload codec in [`Event.ts`](../../../hal-server/src/Event.ts)
now implements.

## JSON.stringify improvises

`JSON.stringify` does not know what the data is meant to be, so it
improvises. `Infinity` and `NaN` become `null`. Keys holding `undefined`
vanish. A `Map` or `Set` becomes `{}` with no error. A `Uint8Array` becomes a
dictionary of indices. A `BigInt` throws. Each of these is a different lie
told to the reader on the other side of the column.

With a typed payload the concern is mostly theoretical — the typechecker
keeps a `Map` out of `{ text: string }`. But an earlier draft of the log took
`payload: unknown`, and there every failure mode in that list was live:
corruption the write gate could not catch, drift no read-side decode would
notice, and a `BigInt` throw surfacing as an untyped defect inside the
`Effect.gen` body instead of a tracked error like `EntryTooLarge`. Narrowing
the input type closed most of that; the codec closes the rest.

## One schema, not two

For a while the file was heading toward two hand-written schemas — one for
the domain shape, one for the storage row. That was the wrong mental model.
**A schema describes a boundary, and a boundary is bidirectional**: every
Effect schema is already a codec with a `Type` side and an `Encoded` side,
and the transformation between them is not a function you write but the
schema itself.

The catch is that `Encoded` is whatever the schema happens to say, not
necessarily something JSON can represent. A struct holding `Schema.BigInt`
encodes to an object still holding a bigint — feed that to `JSON.stringify`
and you are back in the article's failure modes. `Schema.toCodecJson`
(documented in the vendored
[`SCHEMA.md`](../../../repos/effect/packages/effect/SCHEMA.md)) is the
missing declaration: it derives a codec whose encoded side is lawful JSON by
construction. `Schema.fromJsonString` then declares that the two sides differ
by JSON serialisation at that one field. Stacked, they turn the payload
column into a single derivation of the domain shape:

```typescript
const MessagePayload = Schema.Struct({ text: Schema.String });

const MessagePayloadFromJsonString = Schema.fromJsonString(
  Schema.toCodecJson(MessagePayload),
);
```

The one-line mental model: `toCodecJson` answers "what should this value look
like as JSON?", `fromJsonString` answers "now write that JSON as text."

For today's payload of one string field, `toCodecJson` is an identity — a
struct of strings is already JSON, so the wrapper changes nothing at runtime.
What it buys is the guarantee in the type system: the column's content is
JSON by construction, not by everyone remembering to use JSON-friendly
fields. The day a payload grows a `sentAt: Schema.DateTimeUtc` or a
`cost: Schema.BigDecimal` — the effort-accounting work in
[Phase 2](../../design.md) makes that plausible — the derived codec gives the
field its canonical JSON form automatically, instead of a raw object being
handed to `stringify` and mangled the way the article describes.

## Nouns for shapes, verbs for the crossing

With one schema serving both directions, the naming question became: where
does the reader learn that an encode/decode situation exists at all? Alchemy
answers it with a convention its own state layer follows strictly. The domain
shapes in [`ResourceState.ts`](../../../repos/alchemy/packages/alchemy/src/State/ResourceState.ts)
are plain nouns — `ResourceState`, `PersistedState`, variants like
`CreatedResourceState` — with no encoding suffix anywhere on a type. The
domain↔storage transformation lives in its own module,
[`StateEncoding.ts`](../../../repos/alchemy/packages/alchemy/src/State/StateEncoding.ts),
exporting verb-named operations: `encodeState` and `reviveState`. The
storage situation is expressed in the function names; the domain is expressed
in clean noun type names; the two never contaminate each other.

[`Event.ts`](../../../hal-server/src/Event.ts) now follows the same split,
with Effect's own `TypeFromEncoded` convention (`NumberFromString`) covering
the codec constants: `MessagePayload` and `Event` are nouns,
`MessagePayloadFromJsonString` is the codec, and the storage crossings are
the verbs `decodeEvent` and `encodeMessagePayload` — this module's
equivalents of Alchemy's `reviveState` and `encodeState`.

## What is an event, versus how is the table written

Commit `a718ea4e3` split the vocabulary out of the log module, and the
boundary test for what goes where is one sentence:
[`Event.ts`](../../../hal-server/src/Event.ts) answers "what is an event and
how does it cross to text?"; [`EventLog.ts`](../../../hal-server/src/EventLog.ts)
answers "how is the table written and replayed?". The byte cap and the
migration stay with the log because they are properties of the table, not of
events. The split has a payoff beyond tidiness: when the API layer needs the
event vocabulary — to decode wire input, to type what it streams — it imports
`Event.ts` without touching the module that owns storage, which keeps the
log's "nothing else owns any part of the table" claim structurally true
rather than merely documented.

The vocabulary being a union of kinds is not incidental either.
Heterogeneous events are what "everything else is a projection of the log"
means in practice — a log that only held messages would force streaming, task
lifecycle, and cost accounting each back into their own storage, recreating
the fragmentation [attempt two died of](../../event-log-thesis.md).

The directions land asymmetrically in the log, on purpose. Read is forgiving:
`decodeEvent` returns an `Option`, and a malformed row costs exactly one
skipped entry, counted in the
[`ReadResult`](../../../hal-server/src/EventLog.ts) so the forgiveness is
assertable. Write is strict, and strict in two layers: the typechecker keeps
internal callers from constructing a malformed `EventInput`, so when
`encodeMessagePayload` still fails, [`append`](../../../hal-server/src/EventLog.ts)
treats it as a bug in the vocabulary's schema — a defect via `Effect.die`,
not a caller error like `EntryTooLarge`.

## What it changes

The claim that decode and encode are two directions through one declaration
is exactly the kind of claim a test should pin down: a round-trip property —
encode a domain event, decode the row, get the same event back — plus a plain
proof that append-then-read returns what was written. Neither exists yet;
[`thread.integration.test.ts`](../../../hal-server/src/thread.integration.test.ts)
currently holds an empty "write and read to thread works as expected" stub
and a commented-out replay suite. Those tests, not more schema work, are the
next move — the storage-threshold tests already exercise the write gate, but
nothing yet proves the read path decodes what the write path encoded. The
[RPC boundary entry](../what-survives-the-durable-object-rpc-boundary/index.md)
established the pattern for the result crossing back out; this entry's schema
is the pattern for what goes down to disk. Between them, Phase 1's replay
work inherits both directions already declared.
