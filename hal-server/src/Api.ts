import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';
import { HttpServerRequest } from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import Thread from './Thread.ts';

/**
 * The entry Worker, and the *network* entry point — distinct from the domain
 * entry point, which will be a per-human `Agent` object holding the thread
 * index, the schedule, and the notification channels. The Worker answers "who
 * is this and where does it go" before anything downstream sees a request; the
 * agent answers "which thread". Neither carries a message.
 *
 * In Phase 0 it does one interesting thing: resolve the `Threads` Durable
 * Object as a *typed binding* and call a method on it.
 *
 * `yield* Thread` is the whole Alchemy argument — the same declaration that
 * provisions the namespace is the one that types the client, so there is no
 * `wrangler.jsonc` and no generated env to drift from.
 *
 * Routes are `/threads/:id/:action`. The Worker is the runtime boundary that
 * will eventually verify Access and resolve an author identity; until then the
 * author arrives as a query parameter and the Durable Object trusts its caller
 * rather than re-deriving auth.
 */
export default class Api extends Cloudflare.Workers.Worker<Api>()(
  'Api',
  {
    main: import.meta.url,
    observability: {
      enabled: true,
    },
    /**
     * Alchemy bundles the Worker with `minify: true` and `sourcemap: "hidden"`.
     * The map IS written to disk beside the bundle, but no `sourceMappingURL`
     * comment is emitted, so workerd's inspector reports no map and a
     * breakpoint in this file has nothing to bind to.
     *
     * Pointing the debugger at the on-disk map via `cwd`/`outFiles` was tried
     * and does not work: workerd names its scripts with a bare URL ("Api.js"),
     * and js-debug will not resolve that to a file on disk. The map has to
     * arrive through the script itself.
     *
     * So: an inline map, unminified. `sourcemapPathTransform` rewrites sources
     * to absolute paths, because a map whose sources are relative
     * ("../../../src/Api.ts") gives the debugger no anchor and breakpoints stay
     * hollow. Gated on `WORKERD_INSPECTOR_ADDR` — unset, on every ordinary test
     * run and every deploy, the defaults are untouched.
     */
    build: process.env.WORKERD_INSPECTOR_ADDR
      ? {
          output: {
            sourcemap: 'inline',
            minify: false,
            // `URL` is a global in both Node and workerd, so this needs no
            // import — which matters, because this options object is itself
            // part of the Worker bundle.
            sourcemapPathTransform: (source: string, sourcemapPath: string) =>
              new URL(source, `file://${sourcemapPath}`).pathname,
          },
        }
      : undefined,
  },
  Effect.gen(function* () {
    const threads = yield* Thread;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, 'http://hal.local');

        if (url.pathname === '/health') {
          return HttpServerResponse.text('ok');
        }

        const route = matchThreadRoute(url.pathname);
        if (route !== null) {
          const thread = threads.getByName(route.threadId);

          switch (route.action) {
            case 'submit': {
              const text = url.searchParams.get('text');
              if (text === null) {
                return HttpServerResponse.text('text query parameter is required', { status: 400 });
              }
              const result = yield* thread.submit({
                author: url.searchParams.get('author') ?? 'anonymous',
                text,
              });
              /**
               * The write gate's rejection arrives as data rather than as a
               * typed failure, because an `Effect` failure crossing the
               * Durable Object RPC boundary loses its tag. Mapping it here is
               * what keeps a rejected entry distinguishable from a defect.
               */
              return yield* HttpServerResponse.json(result, {
                status: result._tag === 'Rejected' ? 413 : 200,
              });
            }

            case 'read': {
              const after = Number(url.searchParams.get('after') ?? '0');
              const limit = url.searchParams.get('limit');
              const result = yield* thread.read(
                Number.isFinite(after) ? after : 0,
                limit === null ? undefined : Number(limit),
              );
              return yield* HttpServerResponse.json(result);
            }

            case 'diagnostics':
              return yield* HttpServerResponse.json(yield* thread.diagnostics());

            /**
             * `abort` destroys the instance serving this very request, so the
             * response is never delivered — the caller sees a transport error
             * instead of a status code. That is the intended behaviour and the
             * test treats a failed request here as success.
             */
            case 'evict': {
              yield* thread.evict();
              return HttpServerResponse.text('evicted');
            }
          }
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

const ACTIONS = ['submit', 'read', 'diagnostics', 'evict'] as const;

type ThreadRoute = {
  readonly threadId: string;
  readonly action: (typeof ACTIONS)[number];
};

const matchThreadRoute = (pathname: string): ThreadRoute | null => {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length !== 3 || segments[0] !== 'threads') return null;

  const [, threadId, action] = segments;
  if (threadId === undefined || threadId === '') return null;
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return null;

  return { threadId, action: action as (typeof ACTIONS)[number] };
};
