import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";

import Stack from "../alchemy.run.ts";
import * as HttpApiError from "./HttpApiError.ts";
import * as HttpWorker from "./test-support/HttpWorker.ts";

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

afterAll(destroy(Stack));

/**
 * One stack serves the whole file, so every test below addresses a *different*
 * thread — see `HttpWorker.uniqueThread` for why a shared name is a fixture
 * bug that reads as a Durable Object bug.
 */
const worker = Effect.flatMap(stack, ({ url }) => HttpWorker.make(url));

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
      const threadName = HttpWorker.uniqueThread("at-limit");
      const atLimitText = "x".repeat(LIMIT - overhead);

      const { submit } = yield* worker;

      const response = yield* submit({ threadName, text: atLimitText });
      expect(response.status).toBe(200);
    }),
  );

  test(
    "rejects input that is over the storage threshold",
    Effect.gen(function* () {
      const threadName = HttpWorker.uniqueThread("over-limit");
      const overLimitText = "x".repeat(LIMIT + 2);

      const { submit } = yield* worker;

      const response = yield* submit({ threadName, text: overLimitText });
      expect(response.status).toBe(HttpApiError.PayloadTooLarge.status);
    }),
  );
});

test(
  "user writing to thread gets expected response",
  Effect.gen(function* () {
    const author = "larry mcmurty";
    const threadName = HttpWorker.uniqueThread("receipt");
    const text = "user written message";

    const { submit } = yield* worker;

    const response = yield* submit({ threadName, text, author });

    const body = yield* response.json;
    expect(body).toEqual(
      expect.objectContaining({
        receipt: {
          at: expect.any(String),
          seq: 1,
        },
      }),
    );
  }),
);

test(
  "user can write to thread and read back their message",
  Effect.gen(function* () {
    const author = "larry mcmurty";
    const threadName = HttpWorker.uniqueThread("read-back");
    const text = "user written message";
    const cursor = 0;

    const { submit, read } = yield* worker;

    yield* submit({ threadName, text, author });

    const body = yield* read(threadName, cursor);

    expect(body).toEqual({
      events: [
        {
          kind: "message",
          payload: {
            text: text,
          },
          seq: 1,
          author: author,
          at: expect.any(Date),
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

    const threadName = HttpWorker.uniqueThread("multiplayer");

    const authorAMessage = "i'm the best author";
    const authorBMessage = "no, i'm the best author";

    const cursor = 0;

    const { submit, read } = yield* worker;

    yield* submit({ threadName, text: authorAMessage, author: authorA });
    yield* submit({ threadName, text: authorBMessage, author: authorB });

    const { events } = yield* read(threadName, cursor);

    expect(events).toHaveLength(2);
    expect(events.map(({ author }) => author)).toEqual([authorA, authorB]);
  }),
);
