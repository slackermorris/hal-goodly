import * as Cloudflare from "alchemy/Cloudflare";
import * as Vitest from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Schema } from "effect";
import Stack from "../alchemy.run.ts";
import { Echo } from "./Session.ts";

/**
 * The Phase 0 exit test from `docs/design.md`:
 *
 * > An echo round-trips through an Effect runtime at a Durable Object
 * > entrypoint, with Alchemy-declared bindings typed end to end.
 *
 * This test stands up the real stack and drives it over HTTP.
 *
 * Opt in with `HAL_E2E=1 npm test`. It is off by default so `npm run check`
 * stays runnable with no Cloudflare credentials and no resources created.
 *
 * `dev: true` keeps the Worker in local workerd rather than deploying it to the
 * edge — but it still needs a configured Cloudflare profile, because Alchemy
 * resolves the account before planning even in dev mode. Run
 * `npx alchemy login` once first, or set `CI=1` with environment-variable
 * credentials. Drop `dev` (and set a stage) to exercise a genuine deploy.
 */

const { test, deploy, destroy, afterAll } = Vitest.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const decodeReply = Schema.decodeUnknownOption(Echo);

afterAll(destroy(Stack));

// todo: deploy the stack before running the tests
// todo: test the output from the worker

test(
  "echo round-trips through the Durable Object and advances durable state",
  Effect.gen(function* () {
    const deployed = yield* deploy(Stack);
    const baseUrl = deployed.url;
    const client = yield* HttpClient.HttpClient;

    const health = yield* Vitest.executeWhenReady(
      HttpClientRequest.get(`${baseUrl}/health`),
    );
    expect(health.status).toBe(200);
    expect(yield* health.text).toBe("ok");

    const call = (session: string, text: string) =>
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
      });

    // The text comes back formatted by the shared pure function.
    const first = yield* call("alpha", "  hello   world  ");
    expect(first.text).toBe("hello world");
    expect(first.seq).toBe(1);

    // Same session: the counter advances, so storage is genuinely durable
    // across requests rather than per-invocation memory.
    const second = yield* call("alpha", "again");
    expect(second.seq).toBe(2);
    expect(second.sessionId).toBe(first.sessionId);

    // A different session name is a different Durable Object instance, with
    // its own isolated storage.
    const other = yield* call("beta", "hello");
    expect(other.seq).toBe(1);
    expect(other.sessionId).not.toBe(first.sessionId);
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
