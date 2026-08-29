import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import Stack from "../alchemy.run.ts";
import * as HttpApiError from "./HttpApiError.ts";
import type { Diagnostics } from "./Thread.ts";

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
      const threadName = thread.isolationA;
      const atLimitText = "x".repeat(LIMIT - overhead);

      const { submit } = yield* HttpWorker;

      const response = yield* submit({ threadName, text: atLimitText });
      expect(response.status).toBe(200);
    }),
  );

  test(
    "rejects input that is over the storage threshold",
    Effect.gen(function* () {
      const threadName = thread.isolationA;
      const overLimitText = "x".repeat(LIMIT + 2);

      const { submit } = yield* HttpWorker;

      const response = yield* submit({ threadName, text: overLimitText });
      expect(response.status).toBe(HttpApiError.PayloadTooLarge.status);
    }),
  );
});

test(
  "user can write to thread",
  Effect.gen(function* () {
    const author = "larry mcmurty";
    const threadName = thread.isolationB;
    const text = "user written message";
    const cursor = 0;

    const { submit, read } = yield* HttpWorker;

    yield* submit({ threadName, text, author });

    const response = yield* read(threadName, cursor);

    const body = yield* response.json;

    expect(body).toEqual({
      events: [
        {
          kind: "message",
          payload: {
            text: text,
          },
          seq: 1,
          author: author,
          at: expect.any(String),
        },
      ],
      nextCursor: 1,
      skipped: 0,
    });
  }),
);

test(
  "multiple users can write to same thread, multiplayer is supported",
  Effect.gen(function* () {
    const authorA = "larry mcmurty";
    const authorB = "cormack mccarthy";

    const threadName = "thread-c";

    const authorAMessage = "i'm the best author";
    const authorBMessage = "no, i'm the best author";

    const cursor = 0;

    const { submit, read } = yield* HttpWorker;

    yield* submit({ threadName, text: authorAMessage, author: authorA });
    yield* submit({ threadName, text: authorBMessage, author: authorB });

    const response = yield* read(threadName, cursor);

    const { events = [] } = yield* response.json;

    expect(events).toHaveLength(2);
    expect(events.map(({ author }) => author)).toEqual([authorA, authorB]);
  }),
);

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
    submit: ({
      threadName,
      text,
      author = "anonymous",
    }: {
      threadName: string;
      text: string;
      author?: string;
    }) =>
      Effect.gen(function* () {
        const request = HttpClientRequest.post(
          `${baseUrl}/threads/${threadName}/submit`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            text,
            author,
          }),
        );

        return yield* client.execute(request);
      }),

    read: (name: string, after: number) =>
      Effect.gen(function* () {
        return yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/threads/${name}/read?after=${after}`,
          ),
        );
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
