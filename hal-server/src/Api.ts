import * as Cloudflare from 'alchemy/Cloudflare';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import { Result, Schema } from 'effect';
import * as EventLog from './EventLog.ts';
import * as HttpApiError from './HttpApiError.ts';
import Thread, {
  AUTHOR_HEADER,
  CLIENT_HEADER,
  CURSOR_HEADER,
  SubmitResultSchema,
} from './Thread.ts';
import { HttpRouter } from 'effect/unstable/http';

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

    const thread = HttpRouter.params.pipe(Effect.map(({ id }) => threads.getByName(id!)));

    const routes = HttpRouter.addAll([
      HttpRouter.route('GET', '/health', HttpServerResponse.text('ok')),

      HttpRouter.route('GET', '/threads/:id/socket', (request) =>
        Effect.gen(function* () {
          if (request.headers.upgrade !== 'websocket') {
            return HttpServerResponse.text('Expected Upgrade: websocket', {
              status: 426,
            });
          }

          const identity = yield* Effect.result(
            HttpServerRequest.schemaSearchParams(SocketIdentityParams),
          );

          if (Result.isFailure(identity)) {
            return HttpServerResponse.text(
              'expected ?author=<name>&client=<id>&after=<seq> on the socket URL, seq a non-negative integer',
              { status: 400 },
            );
          }

          return yield* (yield* thread).fetch(withIdentityHeaders(request, identity.success));
        }),
      ),

      HttpRouter.route(
        'POST',
        '/threads/:id/submit',
        Effect.gen(function* () {
          const payload = yield* Effect.result(
            HttpServerRequest.schemaBodyJson(SubmitMessagePayload),
          );

          if (Result.isFailure(payload)) {
            return HttpServerResponse.text(
              'expected a JSON body of { text: string, author?: string }',
              { status: 400 },
            );
          }

          const result = yield* (yield* thread).submit({
            author: payload.success.author ?? 'anonymous',
            text: payload.success.text,
          });

          return yield* HttpServerResponse.json(result, {
            status: getResultStatus(result),
          });
        }),
      ),

      HttpRouter.route(
        'GET',
        '/threads/:id/read',
        Effect.gen(function* () {
          const query = yield* Effect.result(HttpServerRequest.schemaSearchParams(ReadQueryParams));

          if (Result.isFailure(query)) {
            return HttpServerResponse.text(
              'expected ?after=<seq>&limit=<n>, both non-negative integers',
              { status: 400 },
            );
          }

          const result = yield* (yield* thread).read(query.success.after, query.success.limit);

          return yield* HttpServerResponse.json(result);
        }),
      ),
      HttpRouter.route(
        'GET',
        '/threads/:id/head',
        Effect.gen(function* () {
          return yield* HttpServerResponse.json(yield* (yield* thread).head());
        }),
      ),

      /**
       * Forced eviction, and the only route here that is not part of the
       * product.
       *
       * `state.abort()` destroys the instance that is serving this very RPC,
       * so the call cannot return — the rejection *is* the confirmation. A
       * clean return would mean the abort never took, and every "survives
       * eviction" assertion downstream of it would then be vacuous. So the two
       * outcomes are reported apart, rather than collapsed into the 500 that
       * an unhandled rejection would otherwise produce.
       *
       * The Worker is a different isolate and is untouched by the abort,
       * which is why it is still here to answer.
       */
      HttpRouter.route(
        'GET',
        '/threads/:id/evict',
        Effect.gen(function* () {
          const outcome = yield* Effect.exit((yield* thread).evict());
          return yield* HttpServerResponse.json(
            EvictionOutcomeSchema.make({
              aborted: Exit.isFailure(outcome),
            }),
          );
        }),
      ),
    ]);

    return {
      fetch: routes.pipe(
        HttpRouter.toHttpEffect,
        Effect.scoped,
        Effect.map(
          Effect.catchTag('HttpServerError', (error) =>
            error.reason._tag === 'RouteNotFound'
              ? Effect.succeed(HttpServerResponse.text('not found', { status: 404 }))
              : Effect.fail(error),
          ),
        ),
      ),
    };
  }),
) {}

/**
 * Forward the upgrade request with the resolved identity as headers.
 *
 * `request.modify({ headers })` is not enough here: when an Effect request
 * wraps a raw `Request`, `HttpServerRequest.toWeb` hands that raw object
 * straight through and the override is lost before it reaches the stub. So
 * the raw request is cloned and the headers are set on the clone.
 */
const withIdentityHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  identity: {
    readonly author: string;
    readonly client: string;
    readonly after: number;
  },
): HttpServerRequest.HttpServerRequest => {
  const raw = new Request(request.source as Request);
  raw.headers.set(AUTHOR_HEADER, identity.author);
  raw.headers.set(CLIENT_HEADER, identity.client);
  raw.headers.set(CURSOR_HEADER, String(identity.after));
  return HttpServerRequest.fromWeb(raw);
};

/**
 * Who is on the other end of a socket. `author` is the human-readable name
 * that attribution shows; `client` is a stable, client-minted id for the
 * device or tab, so one person on two tabs is two clients and one author.
 */
const SocketIdentityParams = Schema.Struct({
  author: Schema.String.check(Schema.isNonEmpty()),
  client: Schema.String.check(Schema.isNonEmpty()),
  /**
   * `withDecodingDefaultKey`, not `withConstructorDefault`: the latter only
   * applies to `.make()`, and search params arrive through decode. The `Key`
   * variant fires on an absent key only, which is the only way a query
   * string can omit a value. Decoded to the log's own cursor here so a bad one
   * is a 400 before the upgrade rather than a failure inside the object.
   */
  after: Schema.FiniteFromString.pipe(
    Schema.decodeTo(EventLog.ReadCursorParams.fields.after),
    Schema.withDecodingDefaultKey(Effect.succeed('0')),
  ),
});

/**
 * The `/read` query string, decoded into the log's own cursor params.
 *
 * This schema only knows about the wire: every field arrives as a string, and
 * a key can be absent but never `undefined`, so `FiniteFromString` parses and
 * `optionalKey` / `withDecodingDefaultKey` handle absence. What a valid cursor
 * *is* — a non-negative integer, a defaulted page size — is
 * `EventLog.ReadCursorParams`, and `decodeTo` runs its checks here so a bad
 * cursor is a 400 at the edge rather than a failure inside the object.
 *
 * `limit` has no default of its own: an absent key passes through, and the
 * log's default fills it.
 */
const ReadQueryParams = Schema.Struct({
  after: Schema.FiniteFromString.pipe(Schema.withDecodingDefaultKey(Effect.succeed('0'))),
  limit: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.decodeTo(EventLog.ReadCursorParams));

const SubmitMessagePayload = Schema.Struct({
  text: Schema.String,
  author: Schema.optional(Schema.String),
});

export const EvictionOutcomeSchema = Schema.Struct({
  aborted: Schema.Boolean,
});

const getResultStatus = SubmitResultSchema.match({
  Accepted: () => 200,
  EntryTooLarge: () => HttpApiError.PayloadTooLarge.status,
});
