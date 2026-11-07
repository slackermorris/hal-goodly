---
planted: 2026-08-22
phase: 0
---

# What survives the Durable Object RPC boundary

[The debugging entry](../debugging-across-the-node-workerd-seam/index.md)
established that `Api.ts` and `Thread.ts` share one workerd isolate. `Thread`
is a Durable Object, but the class lives on the same Worker, so a call into it
never leaves the process. That fact does not matter here. A call through a DO
stub still crosses an RPC boundary, in-process or not, and what comes back out
is narrower than what went in.

## What I tried, and why it did not survive

The first shape of [`Thread.submit`](../../../hal-server/src/Thread.ts) let
the write gate's rejection stay a typed `Effect` failure all the way out, and
tried to `catchTag` it back at the `Api.ts` call site instead. It never
matched. What `Api.ts` received was an opaque `RpcCallError`, not an
`EntryTooLarge` with its `bytes` and `limit` intact.

That is a real gap between the promise and the platform.
[Alchemy's own docs on schemaless RPC](../../../repos/alchemy/website/src/content/docs/apis/schemaless.mdx)
say a tagged failure keeps its `_tag` and its own fields across the wire —
`Effect.catchTag` is supposed to still match on the caller's side. But the
same page is careful about which channel gets that guarantee: a Durable
Object stub is a native structured-clone channel, and "*values* move by
structured clone" is the phrase it uses — not failures. A rejected call is not
a value coming back; it is a promise settling in rejection, on a path Alchemy
does not fully author itself. Whatever shape a rejection takes on that trip,
`EntryTooLarge`'s tag was not still on it by the time `Api.ts` could look.

## Why the remap has to happen inside the DO

The boundary gets one encoding pass, at the moment the call settles, and
there is no second trip back to ask for more detail. Whatever the caller
receives is final — so if the failure path thins the error out before
`Api.ts` ever sees it, no amount of cleverness in `Api.ts`'s `catchTag` can
recover what already did not arrive. The only place that still has the real,
untouched error is `Thread`, before `submit` returns.

The fix, then, is not a smarter catch on the caller's side — it is moving the
catch to the only side where the tag is still real, and handing back a
**value** instead of a failure. A value is the thing the boundary already
carries faithfully.
[`EventLog.EntryTooLarge`](../../../hal-server/src/EventLog.ts) is caught
inside `Thread` now: `submit` never fails for a rejection, it succeeds every
time, and what crosses the wire is data describing which outcome happened,
not a failure that has to survive a trip it cannot survive.

## The first contract: compose, then switch

The first fix (commit `0a68ae38`) declared a success schema and a rejection
schema, then combined them into one union:

```typescript
const AcceptedResultSchema = Schema.Struct({
  _tag: Schema.tag("Accepted"),
  receipt: EventLog.ReceiptSchema,
});

const EntryTooLargeRejectedResultSchema = Schema.Struct({
  _tag: Schema.Literal("Rejected"),
  reason: Schema.Literal("EntryTooLarge"),
  bytes: Schema.Number,
  limit: Schema.Number,
});

const SubmitResultSchema = Schema.Union([
  AcceptedResultSchema,
  EntryTooLargeRejectedResultSchema,
]);
```

`Api.ts` then had to read the encoded response itself. A status mapper
switched on the tag, backed by a hand-written `assertUnreachable` to keep it
exhaustive. It worked, but it read like code a schema library should write
for you.

## `Schema.TaggedUnion` does the switch for you

A grep through the vendored `effect` checkout turned up
[`Schema.TaggedUnion`](../../../repos/effect/packages/effect/SCHEMA.md),
built for exactly this case: one `_tag` discriminant, one case per outcome,
and generated helpers instead of hand-rolled ones. `Thread.ts` now declares
the whole contract in one place:

```typescript
export const SubmitResultSchema = Schema.TaggedUnion({
  Accepted: { receipt: EventLog.ReceiptSchema },
  EntryTooLarge: { bytes: Schema.Number, limit: Schema.Number },
});
```

[`Thread.ts:95-104`](../../../hal-server/src/Thread.ts) builds each outcome
from its generated case, not a literal object:

```typescript
Effect.map((receipt) =>
  SubmitResultSchema.cases.Accepted.make({ receipt }),
),
Effect.catchTag("EntryTooLarge", (error) =>
  Effect.succeed(
    SubmitResultSchema.cases.EntryTooLarge.make({
      bytes: error.bytes,
      limit: error.limit,
    }),
  ),
),
```

`Api.ts` drops the hand-written mapper and the `assertUnreachable`.
[`SubmitResultSchema.match`](../../../hal-server/src/Api.ts) is the
exhaustiveness check now, and the type checker enforces it at the call site
instead of a thrown error at runtime:

```typescript
const getResultStatus = SubmitResultSchema.match({
  Accepted: () => 200,
  EntryTooLarge: () => HttpApiError.PayloadTooLarge.status,
});
```

Add a third outcome and `getResultStatus` fails to compile until it is
handled. The old switch statement reached for the same guarantee by hand, at
greater cost.

## What it changes

This version of `Thread.ts` and `Api.ts` sits in the working tree, not yet
committed. The entry describes code that exists on disk, not yet in history.
`submit` is the only method today whose result crosses the boundary as a
domain verdict rather than a plain success value. It will not stay the only
one. Every Durable Object method Phase 1 onward adds — a rejected join, a
gate's verdict, a task's terminal state — crosses the same RPC mechanism and
needs the same shape. `Schema.TaggedUnion` is now the default answer, not a
one-off fix for `EntryTooLarge`.
