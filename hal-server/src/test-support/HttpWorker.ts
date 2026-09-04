import * as Vitest from "alchemy/Test/Vitest";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { EvictionOutcomeSchema } from "../Api.ts";
import { ReadResponseSchema } from "../EventLog.ts";

/**
 * The deployed stack's HTTP surface, as a test client.
 *
 * One description of each route, shared by every integration file, so a route
 * that changes shape breaks in one place rather than in each suite that had
 * its own copy of the URL.
 *
 * Responses are decoded through the *same* schemas the Worker answers with,
 * rather than cast. `Schema.toCodecJson` derives the wire encoding from the
 * domain schema, so a test reads `at` as a `Date` and `seq` as a number — and
 * a drift between what the log returns and what a suite expects fails at the
 * boundary instead of surviving as an `any`.
 */

const decodeRead = HttpClientResponse.schemaBodyJson(Schema.toCodecJson(ReadResponseSchema));

const decodeEvictionOutcome = HttpClientResponse.schemaBodyJson(
  Schema.toCodecJson(EvictionOutcomeSchema),
);

export const make = (baseUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    /**
     * A freshly-stood-up Worker is not instantly reachable — the route, the
     * script, and each binding propagate independently. `executeWhenReady`
     * rides out that window; without it the first test in a file is racing the
     * deploy.
     */
    yield* Vitest.executeWhenReady(HttpClientRequest.get(`${baseUrl}/health`));

    return {
      baseUrl,

      /**
       * The raw response, not the decoded receipt: a submit is also how the
       * row cap is exercised, and those tests assert on status rather than on
       * a body.
       */
      submit: ({
        threadName,
        text,
        author = "anonymous",
      }: {
        threadName: string;
        text: string;
        author?: string;
      }) =>
        client.execute(
          HttpClientRequest.post(`${baseUrl}/threads/${threadName}/submit`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ text, author }),
          ),
        ),

      read: (threadName: string, after: number, limit?: number) =>
        Effect.flatMap(
          client.execute(
            HttpClientRequest.get(
              `${baseUrl}/threads/${threadName}/read?after=${after}${
                limit === undefined ? "" : `&limit=${limit}`
              }`,
            ),
          ),
          decodeRead,
        ),

      /**
       * Tear the thread's instance down and refuse to continue if it did not
       * actually die.
       *
       * This is the stand-in for `runInDurableObject`, which the Agents SDK
       * uses to read an in-memory field and prove the isolate is new. From
       * outside the isolate there is exactly one witness: `state.abort()`
       * destroys the instance that is serving the call, so the call cannot
       * return. A clean return means the abort did not take — and every
       * assertion downstream of it would then be passing on a thread that was
       * never evicted, which is worse than failing.
       */
      evict: (threadName: string) =>
        Effect.gen(function* () {
          const outcome = yield* Effect.flatMap(
            client.execute(HttpClientRequest.get(`${baseUrl}/threads/${threadName}/evict`)),
            decodeEvictionOutcome,
          );

          if (!outcome.aborted) {
            return yield* Effect.die(
              new Error(
                `abort on thread "${threadName}" returned cleanly, so the instance was never torn down`,
              ),
            );
          }
        }),
    } as const;
  });

export const uniqueThread = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
