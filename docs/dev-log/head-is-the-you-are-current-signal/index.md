---
planted: 2026-09-23
phase: 1
---

# Head is the you-are-current signal

I noticed that I was supporting a partial solution to pagination. I had the
expected cursor params, but I was missing crucial response information.

```typescript
//         ┌─ type ReadCursorParams = {
//         │    readonly after: number;
//         │    readonly limit?: number | undefined;
//         │  }
//         ▼
const ReadCursorParams = Schema.Struct({
  after: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(256))),
  limit: Schema.Number.pipe(Schema.optional),
});

//         ┌─ type ReadResponseSchema = {
//         │    readonly events: readonly {
//         │      readonly at: Date;
//         │      readonly kind: "message";
//         │      readonly payload: {
//         │        readonly text: string;
//         │      };
//         │      readonly author: string;
//         │      readonly seq?: number | undefined;
//         │    }[];
//         │    readonly nextCursor: number;
//         │    readonly skipped: number;
//         │  }
//         ▼
const ReadResponseSchema = Schema.Struct({
  events: Schema.Array(Schema.toType(Event)),
  nextCursor: Schema.Number,
  skipped: Schema.Number,
});
```

The problem with this is that the client does not have enough information on
hand to know whether it was up-to-date with the event log. There is no _you
are now current_ signal.

I thought I could use `nextCursor` as this signal, choosing to set it to
`null` when there was no new logs to be fetched. However, this violates the
purpose of `nextCursor` and introduces a latent bug. Imagine a client gets
up-to-date and is issued a `null` `nextCursor`. From this point on it has lost
any cursor information it can pass to the server when checking for new logs
and has in fact lost this information entirely. Meaning, the client loses the
ability to request new logs.

I needed to return another fit-for-purpose field. A common pattern in what is
returned in a paginated response is to return the `head`, the current tip of
the append-only log. `ReadResponseSchema` becomes:

```typescript
//         ┌─ type ReadResponseSchema = {
//         │    readonly events: readonly {
//         │      ...
//         │    }[];
//         │    readonly nextCursor: number;
//         │    readonly head: number;
//         │    readonly skipped: number;
//         │  }
//         ▼
const ReadResponseSchema = Schema.Struct({
  events: Schema.Array(Schema.toType(Event)),
  nextCursor: Schema.Number,
  head: Schema.Number,
  skipped: Schema.Number,
});
```

The importance of exposing `head` as cursor response information became more
obvious when I considered how I was supporting Web Sockets.

Before attaching a Web Socket client's socket, I have some logic that replays
events as frames:

```typescript
fetch: Effect.gen(function* () {
  // ...
  const page = yield* log.read(after);

  //  ┌─ The replay.
  //  ▼
  for (const event of page.events) {
    yield* socket.send(encodeEventFrame(event));
  }
  // ...
}),
```

However, this logic was very limited. The `read` query sets a hard limit of
256 events. This means that the socket cannot reliably be expected to be
(re)connected with an up-to-date ledger of events. This meant the client
couldn't tell a short page from a truncated one.

For instance, imagine the client loses connection somewhere around the 200th
event, and in the space between it re-connecting some 1,000 events have
occurred. This means its cursor is 200.

```typescript
fetch: Effect.gen(function* () {
  // ...
  const after = 200;
  const page = yield* log.read(after);
  // page = 256 events past the 200th
  // unread events = (1000 - 256) = 744
  for (const event of page.events) {
    yield* socket.send(encodeEventFrame(event));
  }
  // ...
}),
```

It is behind some 744 events and has no signal that it isn't up-to-date. It
has lost an incredible amount of information that other clients whose sockets
have remained connected to the same thread have. It is missing these events
because our replay logic is inaccurate and it is inaccurate because it is not
using the crucial _you are up to date_ signal — `head`.

We can fix this by adjusting the replay logic to consider the `head` and
iterate over available pages until all the events are applied as frames. At
this point, the Web Socket client is up to date and the socket connection can
and should be established. **It is paramount that the client reaches `head`
before attaching a socket.**

Unlike an HTTP client, a socket client drives nothing. It depends on the
server to push, to replay whatever data it depends on. This is why this replay
logic needs to be reliable. Alternatively, an HTTP client is a reader and uses
cursor properties like `nextCursor` to drive iteration or loop control.

```typescript
const replay = Effect.fn(function* (
  socket: Cloudflare.WebSocket,
  after: number,
) {
  let cursor = after;
  let end = Number.POSITIVE_INFINITY;

  do {
    const page = yield* log.read(cursor);
    for (const event of page.events) {
      yield* socket.send(encodeEventFrame(event));
    }

    if (page.nextCursor <= cursor) {
      console.log("No more events to be fetched.");
      break;
    }

    cursor = page.nextCursor;
    end = page.head;
  } while (cursor < end);
});

fetch: Effect.gen(function* () {
  // ...
  yield* replay(socket, after);
  // ...
}),
```

## Where each step lives

`ReadResponseSchema` and the `read` that fills it are in
[`EventLog.ts`](../../../hal-server/src/EventLog.ts). `head` there is
`MAX(seq)`, read in the same call as the page, and it is the same effect the
`/threads/:id/head` route exposes through `Thread.head`. `ReadCursorParams`
is in [`Api.ts`](../../../hal-server/src/Api.ts), and the loop is `replay` in
[`Thread.ts`](../../../hal-server/src/Thread.ts), called from `fetch` after
`Cloudflare.upgrade()` and before the attachment is serialised.

Two details in `read` hold the loop up. `nextCursor` is the `seq` of the last
_row_ fetched, not the last event decoded, so a page whose rows the current
schema cannot decode still advances the cursor and counts them in `skipped`
instead of stalling replay on the same page. And an empty page returns
`Math.min(after, head)` rather than `null`, which settles the "`nextCursor` on
an empty page" item [`design.md`](../../design.md) carried from PR #1: a
current client keeps its cursor, and the `nextCursor <= cursor` guard is what
turns that unchanged cursor into the end of the loop.

The proof is "a client further behind than one page replays all of it before
going live" in
[`thread-websockets.integration.test.ts`](../../../hal-server/src/thread-websockets.integration.test.ts).
It seeds 501 events, nearly two default pages, connects from cursor 0, and
expects every one as a frame, the last being the only one Bob wrote. On the
HTTP side, the write-then-read test in
[`thread.integration.test.ts`](../../../hal-server/src/thread.integration.test.ts)
pins `head` equal to `nextCursor` on a one-event log, which is the you are
current reading an HTTP client makes.

This is the replay half of the join the [SDD](../../sdd.md) calls the only
genuinely racy part of fan-out, and it is why the loop runs in `fetch` rather
than after it. A Durable Object turn does not yield, so draining to `head` and
attaching the socket happen with no append in between. That also makes replay
a stall for every other socket on the thread, which the comment above the call
admits: a client 10,000 events behind holds the object for 40 pages. The
Phase 1 exit test, reconnecting a killed client, is this loop from a non-zero
cursor, and `head` is the item `design.md` can now move out of "still to do".
