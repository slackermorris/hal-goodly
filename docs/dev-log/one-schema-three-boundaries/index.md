---
planted: 2026-08-29
phase: 0
---

# One schema, three boundaries

The shape a caller has to hand [`append`](../../../hal-server/src/EventLog.ts)
is wrong, and it is wrong in a way the editor will tell you without being
asked:

![Editor hover over the `input` parameter of `const append = (input: typeof
Event.Type)`, showing `readonly at: Date`, `readonly kind: "message"`,
`readonly payload: { readonly text: string }`, `readonly author: string`, and
`readonly seq?: number | undefined`](append-input-carries-storage-fields.png)

`at` and `seq` are in there, and neither is a caller's to supply. SQLite
assigns `seq` through `AUTOINCREMENT`; the log assigns `at` at the moment it
builds the row. A `Thread` handling a submit knows the author and the text and
nothing else, which is why
[`Thread.submit`](../../../hal-server/src/Thread.ts) passes exactly `kind`,
`author` and `payload` — and why the workspace does not currently typecheck:

```
src/Thread.ts(89,21): error TS2345: Property 'at' is missing in type
'{ kind: "message"; author: any; payload: { text: any; } }'
```

## What I was trying to get

One hand-written declaration as the source of truth, with every boundary shape
derived from it so no two could drift, and any field mapping sitting as a codec
on the schema itself rather than as a second schema per boundary. That is the
position [One schema, two directions](../one-schema-two-directions/index.md)
argued for and [Three shapes, and how few of them need
declaring](../three-shapes-one-declaration/index.md) tried to hold at three
declarations. `eef950b1a` takes it to one:

```typescript
export const MessageEvent = Schema.Struct({
  seq: Schema.Int.pipe(Schema.optional),
  kind: Schema.Literal('message'),
  author: Schema.String,
  at: Schema.DateFromMillis.pipe(
    Schema.withConstructorDefault(Effect.map(DateTime.now, DateTime.toDateUtc)),
  ),
  payload: Schema.fromJsonString(Schema.toCodecJson(MessagePayload)),
}).annotate({ identifier: 'Event.Message' });

export const Event = Schema.Union([MessageEvent])
  .pipe(Schema.toTaggedUnion('kind'))
  .annotate({ identifier: 'Event' });
```

Two shapes fall out of it, and the delta between them is exactly the set of
storage decisions — `Date` becomes millis, the payload object becomes text:

```typescript
// typeof Event.Type            // typeof Event.Encoded
// the domain event               the row
{ at: Date;                      { at: number;
  kind: "message";                 kind: "message";
  payload: { text: string };       payload: string;
  author: string;                  author: string;
  seq?: number }                   seq?: number }
```

`append` encodes the first into the second and binds the columns;
[`read`](../../../hal-server/src/EventLog.ts) decodes each row back. Both
directions run through one declaration, so the write format cannot drift from
the read expectation. For those two boundaries — the Durable Object RPC hop
and the SQLite row — this holds up.

**The learning is that there is a third boundary, and one schema cannot serve
it.** The API's JSON is not a derivation of the storage encoding, and treating
it as one publishes the storage encoding as the public contract.

## `Schema.optional` switches the default off

The obvious way to silence that type error is to make `at` optional on the
schema:

```typescript
Schema.Struct({
  at: Schema.DateFromMillis.pipe(
    Schema.withConstructorDefault(Effect.map(DateTime.now, DateTime.toDateUtc)),
    Schema.optional,
  ),
});
```

It compiles, and it quietly disables the timestamp. The default is a
_constructor_ default — it only ever fires through `make`, never during an
encode — and `Schema.optional` stops it firing there too:

```typescript
// withConstructorDefault alone
S.make({ author: 'jack' }); // { author: "jack", at: 2026-08-29T01:06:53.502Z }
encode({ author: 'jack' }); // fails: SchemaError(Missing key at ["at"])

// withConstructorDefault, then Schema.optional
S.make({ author: 'jack' }); // { author: "jack" }          ← no default
encode({ author: 'jack' }); // { author: "jack" }          ← no failure
```

Two things change at once, and the second is the dangerous one. Without
`optional`, an event that reaches the encoder without a timestamp **fails
loudly**. With it, the same event encodes cleanly to a row with no `at` at all
— against a column declared `at INTEGER NOT NULL`.

That is the same trap `Model` was rejected for in [Three
shapes](../three-shapes-one-declaration/index.md): a default that only fires
through the constructor, so encoding a plain object drops the field silently.
Rejecting `Model` did not avoid it; the mechanism is `withConstructorDefault`
itself. What keeps it safe here is that there is exactly one funnel —
[`encodeEvent`](../../../hal-server/src/Event.ts) calls `MessageEvent.make`
before it encodes, and `append` is the only caller — so no path to disk skips
the stamp. That single funnel is load-bearing, and `Schema.optional` on `at`
removes the guardrail that would catch it breaking.
