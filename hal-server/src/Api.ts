import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import Session from './Session.ts';

/**
 * The entry Worker. In Phase 0 it does one interesting thing: resolve the
 * `Sessions` Durable Object as a *typed binding* and call a method on it.
 *
 * `yield* Session` is the whole Alchemy argument — the same declaration that
 * provisions the namespace is the one that types the client, so there is no
 * `wrangler.jsonc` and no generated env to drift from.
 */
export default class Api extends Cloudflare.Workers.Worker<Api>()(
  'Api',
  {
    main: import.meta.url,
    observability: {
      enabled: true,
    },
  },
  Effect.gen(function* () {
    const sessions = yield* Session;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, 'http://hal.local');

        if (url.pathname === '/health') {
          return HttpServerResponse.text('ok');
        }

        if (url.pathname.startsWith('/echo/')) {
          const sessionId = url.pathname.slice('/echo/'.length);
          if (sessionId === '') {
            return HttpServerResponse.text('session id is required', {
              status: 400,
            });
          }

          const text = url.searchParams.get('text');
          if (text === null) {
            return HttpServerResponse.text('text query parameter is required', {
              status: 400,
            });
          }

          const session = sessions.getByName(sessionId);
          const reply = yield* session.echo(text);
          return yield* HttpServerResponse.json(reply);
        }

        return HttpServerResponse.text('not found', { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError('unhandled request failure', cause),
            HttpServerResponse.text('internal server error', { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
