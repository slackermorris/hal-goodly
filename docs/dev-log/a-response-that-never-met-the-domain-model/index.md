---
planted: 2026-08-30
phase: 0
---

# A response that never met the domain model

I'm still discovering Schema issues. When testing the `.submit` response, I
noticed that the `at` field was returning a number, where `.read` would return
a string.

This was the `.write` response:

```typescript
type WriteResponse = {
  readonly _tag: 'Accepted';
  readonly receipt: {
    readonly seq: number;
    //                     ┌─ at is a number.
    //                     ▼
    readonly at: number;
  };
};
```

This was the `.read` response:

```typescript
type ReadResponse = {
  readonly events: readonly {
//                 ┌─ at is a Date.
//                 ▼
    readonly at: Date;
    ...,
    readonly seq?: number | undefined;
  }[];
  ...
};
```

A Date is serialised to a String over the wire by `.json` stringify
`yield* HttpServerResponse.json(result)`. Whereas a Number, when serialised,
remains a Number.

`.read` returns a String. `.write` returns a Number.

I discovered the cause for this was that I was using a different Schema to
define and shape the response after successfully writing to storage:

```typescript
const AppendResponseSchema = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
});
```

![Editor hover inside `append` over `const row = yield* cursor.one()`, showing
`const row: { readonly seq: number; readonly at: number }`. The call above it is
`sql.exec<typeof AppendResponseSchema.Type>` with `RETURNING seq, at`, and the
line below it is `return row`](append-returns-the-undecoded-row.png)

In fact, I wasn't even using the domain model when reading for the database and
preparing a response. This was an oversight. The fix was to decode the insert
from the database and return (part of) the output. This would mean `at`
returned to the API layer as a Date, to be serialised into JSON as a String.

## The change

[`append`](../../../hal-server/src/EventLog.ts) was handing back whatever
`RETURNING seq, at` gave it:

```typescript
const cursor = yield* sql.exec<typeof AppendResponseSchema.Type>(
  `INSERT INTO events (kind, author, payload, at)
     VALUES (?, ?, ?, ?)
     RETURNING seq, at`,
  ...
);

const row = yield* cursor.one();

return row;
```

The type argument on `sql.exec` is the tell. It _asserts_ the row's shape
rather than checking it, so `AppendResponseSchema` had drifted into describing
SQLite's columns — two integers — and nothing on the write path ever ran `at`
back through the domain schema, specifically `DateFromMillis`. The read path did, which is the whole
divergence.

Now the written row goes back through the same decode `read` uses, and the
response is built from the decoded domain event:

```typescript
const row = yield * cursor.one();
const decoded = decodeEvent(row);

if (Option.isNone(decoded)) {
  return yield * Effect.die(new Error(`Written event of kind "${input.kind}" was undecodable.`));
}

return AppendResponseSchema.make({
  seq: decoded.value.seq!,
  at: decoded.value.at,
});
```

A row that came straight back out of the insert should not be undecodable, so
the failure is `Effect.die` rather than a tagged error — if it fires, the
schema and the table disagree, and no caller can do anything useful about that.

This worked. However, it made me face a quality of using a single schema across
all boundaries that I don't like, namely that an external payload does not have
the same fields that a payload to be written into the databse has, there are
fields that are strictly of a data layer creation and concern like the
monotonic autoincrement key `seq` and the `at` timestamp. But we get into this
weird world with the single model where those fields are optional at the API
boundary and defined in the storage layer.

The `decoded.value.seq!` above is that tension in one character. `seq` is
optional on the domain event because a caller never supplies it, but a row that
has just been inserted always has one — so the append response has to assert
away an optionality that only ever existed for the benefit of the write path.
[One schema, three boundaries](../one-schema-three-boundaries/index.md) called
this the third boundary and left it open; this is what it costs in practice.
