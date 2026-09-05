import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Socket from "effect/unstable/socket/Socket";
import Stack from "../alchemy.run.ts";
import * as HttpWorker from "./test-support/HttpWorker.ts";

const { test, beforeAll, deploy } = Vitest.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));

test(
  "thread broadcasts messages between peers",
  Effect.gen(function* () {
    const { url } = yield* stack;
    // A fresh thread per run: a reused name would carry hibernated sockets
    // from earlier runs into the broadcast set.
    const threadName = HttpWorker.uniqueThread("broadcast");
    const wsUrl = `${url.replace(/^http/, "ws")}/threads/${threadName}/socket`;

    const alice = yield* connect(wsUrl);
    const bob = yield* connect(wsUrl);

    yield* alice.send("hello bob");

    const received = yield* bob.next;
    expect(received).toMatch(/hello bob$/);
  }).pipe(
    Effect.scoped,
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  ),
  { timeout: 30_000 },
);

const connect = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url);
    const messages = yield* Queue.unbounded<string>();
    const send = yield* socket.writer;
    const opened = yield* Deferred.make<void>();

    yield* Effect.forkScoped(
      socket.runString((msg) => Queue.offer(messages, msg), {
        onOpen: Deferred.succeed(opened, undefined),
      }),
    );

    yield* Deferred.await(opened);

    return {
      send: (msg: string) => send(msg),
      next: Queue.take(messages),
    };
  });
