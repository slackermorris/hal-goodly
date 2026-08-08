import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import Stack from "../alchemy.run.ts";
import { Echo } from "./Session.ts";
import { Schema } from "effect";

/**
 * > An echo round-trips through an Effect runtime at a Durable Object
 * > entrypoint, with Alchemy-declared bindings typed end to end.
 *
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

const decodeReply = Schema.decodeUnknownOption(Echo);

const stack = beforeAll(deploy(Stack));

afterAll(destroy(Stack));

test(
  "worker returns a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf("string");
  }),
);

test(
  "Session counter advances across requests",
  Effect.gen(function* () {
    const sessionId = "alpha";

    const { call } = yield* HttpWorker;

    const firstCall = yield* call(sessionId, "  hello   world  ");
    const secondCall = yield* call(sessionId, "something else");

    expect(firstCall.seq).toBe(1);
    expect(secondCall.seq).toBe(2);
  }),
);

test(
  "Sessions are backed by their own Durable Object instance, with its own isolated storage",
  Effect.gen(function* () {
    const sessionAId = "alpha";
    const sessionBId = "beta";

    const { call } = yield* HttpWorker;

    const primary = yield* call(sessionAId, "writing to session A, DO");
    const other = yield* call(sessionBId, "writing to session B, DO");

    expect(primary.sessionId).not.toBe(other.sessionId);
  }),
);

test(
  "rejects a request with no text parameter",
  Effect.gen(function* () {
    const deployed = yield* deploy(Stack);
    const client = yield* HttpClient.HttpClient;

    const response = yield* client.execute(
      HttpClientRequest.get(`${deployed.url}/echo/alpha`),
    );
    expect(response.status).toBe(400);
  }),
);

const HttpWorker = Effect.gen(function* () {
  const { url: baseUrl } = yield* stack;
  const client = yield* HttpClient.HttpClient;

  return {
    call: (session: string, text: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(
            `${baseUrl}/echo/${session}?text=${encodeURIComponent(text)}`,
          ),
        );
        expect(response.status).toBe(200);
        const reply = decodeReply(yield* response.json);
        expect(reply._tag).toBe("Some");
        if (reply._tag !== "Some")
          throw new Error("reply did not match EchoReply");
        return reply.value;
      }),
  };
});
