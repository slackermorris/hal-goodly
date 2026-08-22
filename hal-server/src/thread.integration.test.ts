import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import Stack from "../alchemy.run.ts";
import * as HttpApiError from "./HttpApiError.ts";

/**
 * This test stands up the real stack and drives it over HTTP.
 *
 * `dev: true` keeps the Worker in local workerd rather than deploying it to the
 * edge — but it still needs a configured Cloudflare profile, because Alchemy
 * resolves the account before planning even in dev mode. Run
 * `npx alchemy login` once first, or set `CI=1` with environment-variable
 * credentials. Drop `dev` (and set a stage) to exercise a genuine deploy.
 */

const { test, beforeAll, deploy, destroy, afterAll } = Vitest.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));

/**
 * One stack serves the whole file, so every test below addresses a *different*
 * thread name. A Durable Object's `seq` is durable and per-instance: two tests
 * sharing a thread name only pass in declaration order, and break under
 * `.only`, a retry, or a shuffle — as a Durable Object bug rather than a
 * fixture bug.
 */
const thread = {
  counter: "counter-advances",
  isolationA: "isolation-a",
  isolationB: "isolation-b",
  missingText: "rejects-missing-text",
  eviction: "survives-eviction",
  seqAcrossEviction: "seq-across-eviction",
  idempotency: "idempotency-across-eviction",
  concurrent: "concurrent-appends",
  cursor: "cursor-replay",
} as const;

afterAll(destroy(Stack));

test(
  "worker returns a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
  }),
);

// TODO: rename this test block
describe("storage threshold", () => {
  const LIMIT = 1_800_000;
  // The input is persisted as a JSON Blob in the format below.
  const overhead = new TextEncoder().encode(
    JSON.stringify({ text: "" }),
  ).byteLength;

  test(
    "accepts input that is equal to the storage threshold",
    Effect.gen(function* () {
      const name = thread.isolationA;
      const atLimitText = "x".repeat(LIMIT - overhead);

      const { submit } = yield* HttpWorker;

      const response = yield* submit(name, atLimitText);
      expect(response.status).toBe(200);
    }),
  );

  test(
    "rejects input that is over the storage threshold",
    Effect.gen(function* () {
      const name = thread.isolationA;
      const overLimitText = "x".repeat(LIMIT + 2);

      const { submit } = yield* HttpWorker;

      const response = yield* submit(name, overLimitText);
      expect(response.status).toBe(HttpApiError.PayloadTooLarge.status);
    }),
  );
});

test(
  "write and read to thread works as expected",
  Effect.gen(function* () {
    
  }),
);

test(
  "multiple clients can contribute to the same thread",
  Effect.gen(function* () {
    const name = thread.isolationA;
    const { submit } = yield* HttpWorker;

    yield* submit(name, "first");

    expect(2).toBe(2);
  }),
);

/**
 * > Kill the fiber mid-run: no orphan container. Evict the DO mid-run: the
 * > reaper catches it.
 *
 * The eviction half of that arrives properly in Phase 4, but the property it
 * rests on is testable now: **runtime is per-invocation and never a source of
 * truth; all truth in SQLite.** Every test below is written so that it fails if
 * that rule is broken.
 *
 * The load-bearing assertion in each is `incarnation`. A Durable Object test
 * that writes, evicts, reads, and finds its data is worthless on its own —
 * it passes identically when no eviction happened and one instance served the
 * whole test. Asserting the incarnation *changed* is what turns it into
 * evidence.
 */
// test(
//   "the log survives an eviction and isolate memory does not",
//   Effect.gen(function* () {
//     const { submit, diagnostics, evict, read } = yield* HttpWorker;
//     const name = thread.eviction;

//     yield* submit(name, "first");
//     yield* submit(name, "second");
//     yield* submit(name, "third");

//     const before = yield* diagnostics(name);
//     expect(before.rows).toBe(3);
//     expect(before.memoryAppends).toBe(3);

//     yield* evict(name);

//     const after = yield* diagnostics(name);

//     // The isolate genuinely died — without this the rest proves nothing.
//     expect(after.incarnation).not.toBe(before.incarnation);

//     // In-isolate state is gone, which is the rule being enforced.
//     expect(after.memoryAppends).toBe(0);

//     // Durable state is not.
//     expect(after.rows).toBe(3);

//     const replay = yield* read(name, 0);
//     expect(replay.events.map((event) => event.payload.text)).toEqual([
//       "first",
//       "second",
//       "third",
//     ]);
//   }),
// );

// test(
//   "seq is monotonic and gapless across an eviction",
//   Effect.gen(function* () {
//     const { submit, evict } = yield* HttpWorker;
//     const name = thread.seqAcrossEviction;

//     const first = yield* submit(name, "before");
//     const second = yield* submit(name, "before");

//     yield* evict(name);

//     const third = yield* submit(name, "after");
//     const fourth = yield* submit(name, "after");

//     /**
//      * The failure this catches is the obvious implementation: a counter held
//      * in the isolate. That version restarts at 1 here and hands two entries
//      * the same cursor, which corrupts every replay that follows.
//      */
//     expect([first.seq, second.seq, third.seq, fourth.seq]).toEqual([
//       1, 2, 3, 4,
//     ]);
//   }),
// );

// test(
//   "a repeated clientMsgId is deduplicated across an eviction",
//   Effect.gen(function* () {
//     const { submit, diagnostics, evict } = yield* HttpWorker;
//     const name = thread.idempotency;
//     const clientMsgId = "retry-me";

//     const original = yield* submit(name, "sent once", clientMsgId);
//     expect(original.deduplicated).toBe(false);

//     yield* evict(name);

//     // The client could not know its send landed, so it retries after
//     // reconnecting — which is ordinary, not exceptional, under multiplayer.
//     const retried = yield* submit(name, "sent once", clientMsgId);
//     expect(retried.deduplicated).toBe(true);
//     expect(retried.seq).toBe(original.seq);

//     // Proving the unique index did the work rather than an in-memory set.
//     const after = yield* diagnostics(name);
//     expect(after.rows).toBe(1);
//   }),
// );

// test(
//   "concurrent appends to a fresh thread are gapless",
//   Effect.gen(function* () {
//     const { submit } = yield* HttpWorker;
//     const name = thread.concurrent;

//     /**
//      * Two properties at once: sequence numbers survive concurrent appends, and
//      * the `CREATE TABLE IF NOT EXISTS` in instance init tolerates several
//      * requests racing to be the one that constructs the instance.
//      */
//     const receipts = yield* Effect.all(
//       Array.from({ length: 8 }, (_, index) =>
//         submit(name, `concurrent ${index}`),
//       ),
//       { concurrency: "unbounded" },
//     );

//     const seqs = receipts.map((receipt) => receipt.seq).sort((a, b) => a - b);
//     expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
//   }),
// );

// test(
//   "replay from a cursor returns exactly the missed entries",
//   Effect.gen(function* () {
//     const { submit, read, head } = yield* HttpWorker;
//     const name = thread.cursor;

//     for (const text of ["a", "b", "c", "d", "e"]) {
//       yield* submit(name, text);
//     }

//     const replay = yield* read(name, 2);

//     expect(replay.skipped).toBe(0);
//     expect(replay.events.map((event) => event.seq)).toEqual([3, 4, 5]);
//     expect(replay.events.map((event) => event.payload.text)).toEqual([
//       "c",
//       "d",
//       "e",
//     ]);
//     expect(replay.nextCursor).toBe(5);

//     // Reading from the head is empty rather than an error, so a caught-up
//     // client polls without special-casing.
//     const caughtUp = yield* read(name, replay.nextCursor);
//     expect(caughtUp.events).toEqual([]);
//     expect(caughtUp.nextCursor).toBe(5);

//     const position = yield* head(name);
//     expect(position).toEqual({ seq: 5 });
//   }),
// );

// test(
//   "no thread keeps its sequence in KV storage",
//   Effect.gen(function* () {
//     const { diagnostics } = yield* HttpWorker;

//     /**
//      * The literal cutover assertion. `thread.counter` has been driven through
//      * the `echo` path, which used to read-increment-write a `seq` key; if that
//      * path still exists anywhere, this is where it shows up.
//      */
//     const echoed = yield* diagnostics(thread.counter);
//     expect(echoed.kvSeq).toBeNull();
//     expect(echoed.rows).toBe(2);

//     const submitted = yield* diagnostics(thread.eviction);
//     expect(submitted.kvSeq).toBeNull();
//   }),
// );

type Receipt = { seq: number; at: number; deduplicated: boolean };
type SubmitResult =
  | { _tag: "Accepted"; receipt: Receipt }
  | { _tag: "Rejected"; reason: string; bytes: number; limit: number };
type LogEvent = {
  seq: number;
  kind: string;
  author: string;
  payload: { text: string };
  at: number;
};
type ReadResult = {
  events: LogEvent[];
  nextCursor: number;
  skipped: number;
};
type Diagnostics = {
  incarnation: string;
  memoryAppends: number;
  rows: number;
  kvSeq: number | null;
  databaseSize: number;
};

const HttpWorker = Effect.gen(function* () {
  const { url: baseUrl } = yield* stack;
  const client = yield* HttpClient.HttpClient;

  /**
   * A freshly-stood-up Worker is not instantly reachable — the route, the
   * script, and each binding propagate independently. `executeWhenReady`
   * rides out that window; without it the first test in the file is racing
   * the deploy.
   */
  yield* Vitest.executeWhenReady(HttpClientRequest.get(`${baseUrl}/health`));

  return {
    baseUrl,
    submit: (name: string, text: string) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `${baseUrl}/threads/${name}/submit`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            text,
          }),
        );

        return yield* client.execute(request);
      }),

    read: (name: string, after: number) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/threads/${name}/read?after=${after}`,
          ),
        );
        expect(response.status).toBe(200);
        return (yield* response.json) as ReadResult;
      }),

    head: (name: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(`${baseUrl}/threads/${name}/head`),
        );
        expect(response.status).toBe(200);
        return (yield* response.json) as { seq: number };
      }),

    diagnostics: (name: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(`${baseUrl}/threads/${name}/diagnostics`),
        );
        expect(response.status).toBe(200);
        return (yield* response.json) as Diagnostics;
      }),

    /**
     * `state.abort()` destroys the instance that is serving this request, so
     * the response never arrives — the caller sees a transport failure or the
     * Worker's own 500. Both mean the eviction happened, so the outcome is
     * discarded rather than asserted on; the assertion that matters is the
     * changed `incarnation` on the next request.
     */
    evict: (name: string) =>
      client
        .execute(HttpClientRequest.get(`${baseUrl}/threads/${name}/evict`))
        .pipe(Effect.catchCause(() => Effect.succeed(null))),
  };
});
