import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";

import Stack from "../alchemy.run.ts";
import * as HttpWorker from "./test-support/HttpWorker.ts";

/**
 * Forced Durable Object eviction coverage for a thread's event log.
 *
 * Every test here tears the instance down explicitly, re-enters through a
 * fresh request, and asserts that what comes back was reconstructed from
 * durable storage.
 *
 * This does **not** assert natural idle hibernation, the absence of pending
 * timers, or hibernation eligibility. A forced teardown is not hibernation,
 * and a green run here says nothing about either.
 *
 * ## Why the eviction is driven over HTTP
 *
 * The Cloudflare Agents SDK gets this from `evictDurableObject()` in
 * `cloudflare:test`, which only exists when the test body itself runs inside
 * workerd under `@cloudflare/vitest-pool-workers` — which in turn needs a
 * `wrangler.jsonc` to describe the bindings. Hal has neither, deliberately
 * (see AGENTS.md): Alchemy's declaration is the only description of the stack,
 * and a hand-written wrangler config would be a second one to drift from.
 *
 * So the test process stays in Node and asks the Worker to abort the instance
 * instead. What happens to the isolate is the same; who calls it differs.
 *
 * ## What that costs, and how it is paid for
 *
 * Running outside workerd also gives up `runInDurableObject`, which the SDK
 * suites use to read an in-memory field and prove the isolate is genuinely
 * new. Without it, an eviction test can pass while evicting nothing: durable
 * state survives a teardown that never happened, too.
 *
 * The witness is that `state.abort()` destroys the instance mid-RPC, so the
 * call cannot return cleanly. `HttpWorker.evict` asserts exactly that and
 * kills the test if the abort was a no-op, so the assertions below are only
 * ever reached on a thread that really was torn down.
 */

const { test, beforeAll, deploy, destroy, afterAll } = Vitest.make({
  providers: Cloudflare.providers(),
  dev: true,
  /**
   * Its own stage, and therefore its own Worker and its own Durable Object
   * namespace. Vitest runs files in parallel, and two files deploying the same
   * stack to the same stage would race each other's state.
   */
  stage: "eviction",
});

const stack = beforeAll(deploy(Stack));

afterAll(destroy(Stack));

const worker = Effect.flatMap(stack, ({ url }) => HttpWorker.make(url));

test(
  "the log is rebuilt from durable storage on the next request",
  Effect.gen(function* () {
    const threadName = HttpWorker.uniqueThread("evict-survives");
    const author = "john boot";

    const { submit, evict, read } = yield* worker;

    yield* submit({ threadName, text: "before the eviction", author });

    yield* evict(threadName);

    yield* submit({ threadName, text: "after the eviction", author });

    const { events } = yield* read(threadName, 0);

    expect(events.map((event) => event.payload.text)).toEqual([
      "before the eviction",
      "after the eviction",
    ]);
  }),
);

test(
  "seq continues from durable state rather than restarting at 1",
  Effect.gen(function* () {
    const threadName = HttpWorker.uniqueThread("evict-seq");
    const author = "john boot";

    const { submit, evict, read } = yield* worker;

    yield* submit({ threadName, text: "one", author });
    yield* submit({ threadName, text: "two", author });

    yield* evict(threadName);

    yield* submit({ threadName, text: "three", author });

    const { events, nextCursor } = yield* read(threadName, 0);

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(nextCursor).toBe(3);
  }),
);
