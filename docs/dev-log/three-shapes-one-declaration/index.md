---
planted: 2026-08-27
phase: 0
---

# Three shapes, and how few of them need declaring

[One schema, two directions](../one-schema-two-directions/index.md) settled how
a payload crosses into SQLite. This is the sequel: the same event also has to
cross into JSON for the API, and for a while
[`Event.ts`](../../../hal-server/src/Event.ts) declared that third shape by
hand. Two hand-written encodings of one domain model is two things to keep in
step, and the write path had already fallen out of step without anyone
noticing.

## The write path was never going through the codec

`Event.ts` claimed that "decode and encode are the two directions through the
same schema, so the write format cannot drift from the read expectation." That
was false. `EventLog.append` bound four columns by hand and wrote
`at = Date.now()` as a raw number; only the payload column went through a
codec.

The failure that sets up is quiet. Add a field to the event, and the hand-
written `INSERT` does not gain a column — the `SELECT` is a template string, so
nothing typechecks it. The new column is absent, `decodeEvent` returns
`Option.none`, and the log's forgiving-on-read behaviour does exactly what it
was designed to do: counts one `skipped`, logs a warning, and drops the row.
Every row. Schema drift arrives as silent data loss rather than a failed build.

The fix is to make the write shape a schema too, so `append` encodes a whole
row and binds from the result. It does not take much: the event's fields are a
plain object, so the insert shape is that object without `seq`, and both go
through `Schema.Struct`.

## Only two of the three shapes need declaring

The JSON boundary does not. `Schema.toCodecJson` derives a canonical JSON codec
from any schema by lowering each declaration through the JSON form it carries;
`Schema.Date` declares an ISO string. And every HTTP entry point already applies
that derivation to whatever schema it is handed:

- `HttpServerResponse.schemaJson` → `HttpBody.jsonSchema` → `toCodecJson`
- `HttpClientResponse.schemaBodyJson` → `HttpIncomingMessage` → `toCodecJson`
- `HttpApiEndpoint` success and payload → `toCodecJson`; headers and params get
  `toCodecStringTree`

Which is why Effect's own `api/Users.ts` fixture can write `success: User` with
no wire schema anywhere in the example. There is no wire declaration to keep in
step because there is no wire declaration.

A SQLite row layout, by contrast, is not derivable and never will be. Which
fields become columns, that `payload` is TEXT rather than a nested object, that
`at` is INTEGER, that `seq` is `AUTOINCREMENT` — those are choices, not
consequences. There is no canonical row codec in the "Canonical Codecs" section
of `Schema.ts`, only `toCodecJson`, `toCodecStringTree`, `toCodecIso`, and
`toCodecArrayFromSingle`.

So the floor is two declarations, not three: the domain model, and the row
mapping. Plus the insert variant, which is a third thing no derivation knows —
"`seq` is the database's" and "`at` is the log's" are facts about the write.

## The trap: toCodecJson does not undo an encoding

`toCodecJsonAST` is `applyToSelfOrLastLinkEncodingIdempotent`. It lowers
*declarations*, but leaves an existing encoding alone when that encoding is
already lawful JSON. Millis and JSON-text both are. So handing a boundary a
schema that still carries the storage encoding ships the storage encoding to
the client:

```
schemaJson(rowEncodedSchema)   → "at":1787792523456, "payload":"{\"text\":\"hi\"}"
schemaJson(toType(sameSchema)) → "at":"2026-08-27T01:02:03.456Z", "payload":{"text":"hi"}
```

Hence `EventDomain = Schema.toType(EventFromRow)` — the same model with no
encoding attached — as the thing boundaries name.

## The detour through Model, and why it was abandoned

`effect/unstable/schema/Model` — `@effect/sql`'s `Model` before it moved into
core — exists for exactly this: one field declaration, from which `select`,
`insert`, `update` and `json` variants are derived. `Model.JsonFromString` is
literally `fromJsonString(toCodecJson(payload))`, and `Model.GeneratedByDb` is a
field present on reads and absent on inserts. It fit, it worked, and it was
still the wrong trade here.

Two reasons. It is heavier than the problem: the whole apparatus bought one
`seq` omission and one timestamp default, both of which are three lines of plain
`Schema.Struct` and an explicit stamp in the write path. And it hides the wrong
thing — `seq` is genuinely SQLite's to assign, but `at` is assigned by *our*
code, and burying that in a `VariantSchema.Overrideable` default made the two
look alike. Worse, that default only fires through the variant's constructor, so
encoding a plain object drops `at` silently.

Two sharp edges found on the way out, worth recording in case anyone returns to
it at 4.0.0-beta.102:

- **`Model.Union` drops `Model.Struct` members.** Its member list is filtered
  with `Schema.isSchema`, and a variant struct is not a schema, so a union of
  structs becomes `Schema.Union([])` and every decode fails with
  `Expected never`. Fixed upstream in beta.106.
- **A union's `.insert` loses its members' constructor defaults**, being a plain
  `Schema.Union` — so a defaulted field silently goes missing.

And a lesson that outlived the detour: `Model.Class` decodes to a class
instance, and the domain event crosses the Durable Object RPC boundary, where
[structured clone does not preserve
prototypes](../what-survives-the-durable-object-rpc-boundary/index.md). Plain
objects survive that hop with their prototypes intact because they have none to
lose — the same lesson as `DateTime.Utc` versus `Date`, one layer up.

## Build shapes by addition

The last thing to go was an `Omit`. `EventInput` began as
`Omit<Event.Type, "seq" | "at">` — the input defined by what the event lacks —
and no schema file in either vendored repo does that. What they do instead is
declare the input outright, as its own small schema:
`CreateRepoPayload` is two fields against `RepoInfo`'s eleven, and
`CreateTodoPayload` is one against `Todo`'s three. The overlap is duplicated
without apology, because a boundary contract is an independent thing that
merely resembles the domain.

So: declare the smallest shape, and compose upward. `MessageInput` is what a
caller may send; the row adds `at`; the read adds `seq`. Nothing is defined by
subtraction, and a future kind whose input carries a field the event does not —
an idempotency key, say — stays expressible.
