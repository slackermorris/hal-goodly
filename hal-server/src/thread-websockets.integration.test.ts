import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/unstable/socket/Socket";
import Stack from "../alchemy.run.ts";
import { decodeEventFrame } from "./Event.ts";
import * as HttpWorker from "./test-support/HttpWorker.ts";

const { test, beforeAll, deploy } = Vitest.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));

/**
 * One stack serves the whole file, so every test below addresses a *different*
 * thread — see `HttpWorker.uniqueThread` for why a shared name is a fixture
 * bug that reads as a Durable Object bug.
 */
const worker = Effect.flatMap(stack, ({ url }) => HttpWorker.make(url));

test(
  "thread broadcasts messages between peers, attributed to the sender",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // A fresh thread per run: a reused name would carry hibernated sockets
    // from earlier runs into the broadcast set.
    const threadName = HttpWorker.uniqueThread("broadcast");

    const alice = yield* connect(socketUrl(url, threadName, "alice"));
    const bob = yield* connect(socketUrl(url, threadName, "bob"));

    yield* alice.send("hello bob");

    // What bob receives is the persisted event, `seq` included, not a string
    // built from the incoming frame.
    const received = yield* bob.next;
    expect(received).toEqual(
      expect.objectContaining({
        kind: "message",
        seq: 1,
        author: "alice",
        payload: { text: "hello bob" },
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  { timeout: 30_000 },
);

test(
  "a message sent over a socket is appended to the log under its author",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const threadName = HttpWorker.uniqueThread("persist");

    const { read } = yield* worker;

    const alice = yield* connect(socketUrl(url, threadName, "alice"));
    const bob = yield* connect(socketUrl(url, threadName, "bob"));

    yield* alice.send("hello bob");

    // Bob's frame is the proof the object has handled the message. The handler
    // appends before it broadcasts, so once this arrives the row is committed
    // and the read below cannot race the send.
    const received = yield* bob.next;
    expect(received.seq).toBe(1);

    const { events, nextCursor } = yield* read(threadName, 0);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: "message",
        seq: 1,
        author: "alice",
        payload: { text: "hello bob" },
      }),
    );
    expect(nextCursor).toBe(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  { timeout: 30_000 },
);

test(
  "peers read from log on initial load",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const threadName = HttpWorker.uniqueThread("replay");

    const firstMessageAlice = "first entry";
    const secondMessageAlice = "second entry";
    const thirdMessageBob = "third entry";

    const bobAuthor = "bob";
    const aliceAuthor = "alice";

    const { read, submit } = yield* worker;

    yield* submit({ threadName, text: firstMessageAlice, author: aliceAuthor });
    yield* submit({
      threadName,
      text: secondMessageAlice,
      author: aliceAuthor,
    });
    yield* submit({ threadName, text: thirdMessageBob, author: bobAuthor });

    // Both join after the fact. Nothing is sent live, so every frame below
    // came from the log, in `seq` order, and the same three frames reach a
    // peer regardless of who they are.
    const alice = yield* connect(socketUrl(url, threadName, aliceAuthor));
    const bob = yield* connect(socketUrl(url, threadName, bobAuthor));

    const bobSaw = [yield* bob.next, yield* bob.next, yield* bob.next];
    expect(bobSaw.map((e) => [e.seq, e.author, e.payload.text])).toEqual([
      [1, aliceAuthor, firstMessageAlice],
      [2, aliceAuthor, secondMessageAlice],
      [3, bobAuthor, thirdMessageBob],
    ]);

    const aliceSaw = [yield* alice.next, yield* alice.next, yield* alice.next];
    expect(aliceSaw.map((e) => e.seq)).toEqual([1, 2, 3]);

    // A cursor skips what the client already holds.
    const late = yield* connect(socketUrl(url, threadName, "carol", "2"));
    const lateSaw = yield* late.next;
    expect(lateSaw.seq).toBe(3);
  }).pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  { timeout: 30_000 },
);

const socketUrl = (
  baseUrl: string,
  threadName: string,
  author: string,
  after: string = "0",
) => {
  const url = new URL(`${baseUrl}/threads/${threadName}/socket`);
  url.protocol = url.protocol.replace(/^http/, "ws");
  url.searchParams.set("author", author);
  url.searchParams.set("client", crypto.randomUUID());
  url.searchParams.set("after", after);
  return url.toString();
};

const connect = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url);
    const messages = yield* Queue.unbounded<string>();
    const send = yield* socket.writer;
    const opened = yield* Deferred.make<void>();

    const running = yield* Effect.forkScoped(
      socket.runString((msg) => Queue.offer(messages, msg), {
        onOpen: Deferred.succeed(opened, undefined),
      }),
    );

    /**
     * Wait for the socket to open, but let a refused upgrade fail the test now
     * rather than at the timeout.
     *
     * `running` is the socket's whole life: it performs the handshake, pumps
     * frames into the queue, and only ends when the socket closes or fails.
     * `opened` is resolved from its `onOpen`. If the route answers the
     * handshake with a 400 or 500 instead of a 101, `onOpen` never fires, so
     * waiting on `opened` alone would hang for the full test timeout with no
     * hint of the cause.
     *
     * So the wait is raced against the fiber's own exit, and the three
     * outcomes fall out of that:
     *
     * - The handshake succeeds: `opened` resolves first and wins. Losing the
     *   race interrupts the `join`, which is only an observer; the socket
     *   fiber itself keeps running for the rest of the scope.
     * - The upgrade is refused: the fiber fails with the `SocketError` from
     *   the handshake, `join` fails with it, and that failure wins, so the
     *   test reports the real error.
     * - The socket closes cleanly without ever opening: the fiber succeeds,
     *   the `flatMap` runs, and we die, because nothing in this code path
     *   should ever produce that.
     *
     * `raceFirst`, not `race`: `race` treats a failure as a loss and keeps
     * waiting for the other side to succeed, which would put us back at the
     * timeout. `raceFirst` settles on the first exit of either kind.
     */
    yield* Effect.raceFirst(
      Deferred.await(opened),
      Effect.flatMap(Fiber.join(running), () =>
        Effect.die(new Error("socket closed before it opened")),
      ),
    );

    return {
      send: (msg: string) => send(msg),
      next: Effect.map(Queue.take(messages), decodeEventFrame),
    };
  });
