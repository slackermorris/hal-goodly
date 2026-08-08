import * as Cloudflare from 'alchemy/Cloudflare';
import * as Vitest from 'alchemy/Test/Vitest';
import { Schema } from 'effect';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/unstable/http/HttpClient';
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest';

import Stack from '../alchemy.run.ts';
import { Echo } from './Session.ts';

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

/**
 * One stack serves the whole file, so every test below addresses a *different*
 * session name. A Durable Object's `seq` is durable and per-instance: two tests
 * sharing a session name only pass in declaration order, and break under
 * `.only`, a retry, or a shuffle — as a Durable Object bug rather than a
 * fixture bug.
 */
const session = {
  counter: 'counter-advances',
  isolationA: 'isolation-a',
  isolationB: 'isolation-b',
  missingText: 'rejects-missing-text',
} as const;

afterAll(destroy(Stack));

test(
  'worker returns a url',
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeTypeOf('string');
  }),
);

test(
  'Session counter advances across requests',
  Effect.gen(function* () {
    const { call } = yield* HttpWorker;

    const firstCall = yield* call(session.counter, '  hello   world  ');
    const secondCall = yield* call(session.counter, 'something else');

    // The echo comes back formatted by the shared function, not merely echoed.
    expect(firstCall.text).toBe('hello world');

    expect(firstCall.seq).toBe(1);
    expect(secondCall.seq).toBe(2);
  }),
);

test(
  'Sessions are backed by their own Durable Object instance, with its own isolated storage',
  Effect.gen(function* () {
    const { call } = yield* HttpWorker;

    const primary = yield* call(session.isolationA, 'writing to session A, DO');
    const other = yield* call(session.isolationB, 'writing to session B, DO');

    expect(primary.sessionId).not.toBe(other.sessionId);

    // Isolated storage, not just distinct identity: each instance's counter
    // starts from its own zero.
    expect(primary.seq).toBe(1);
    expect(other.seq).toBe(1);
  }),
);

test(
  'rejects a request with no text parameter',
  Effect.gen(function* () {
    const { baseUrl } = yield* HttpWorker;
    const client = yield* HttpClient.HttpClient;

    const response = yield* client.execute(
      HttpClientRequest.get(`${baseUrl}/echo/${session.missingText}`),
    );
    expect(response.status).toBe(400);
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
    call: (session: string, text: string) =>
      Effect.gen(function* () {
        const response = yield* client.execute(
          HttpClientRequest.get(`${baseUrl}/echo/${session}?text=${encodeURIComponent(text)}`),
        );
        expect(response.status).toBe(200);
        const reply = decodeReply(yield* response.json);
        expect(reply._tag).toBe('Some');
        if (reply._tag !== 'Some') throw new Error('reply did not match Echo');
        return reply.value;
      }),
  };
});
