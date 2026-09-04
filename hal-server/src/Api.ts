import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Result, Schema } from "effect";
import * as HttpApiError from "./HttpApiError.ts";
import Thread, { SubmitResultSchema } from "./Thread.ts";

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
  "Api",
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
            sourcemap: "inline",
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
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.url, "http://hal.local");

        if (url.pathname === "/health") {
          return HttpServerResponse.text("ok");
        }

        const route = matchThreadRoute(url.pathname);
        if (route !== null) {
          const thread = threads.getByName(route.threadId);

          switch (route.action) {
            case "submit": {
              /**
               * A body rather than query params: a message can approach the
               * log's row cap, and a URL that size never reaches the server —
               * the request line itself gets rejected long before workerd
               * sees it.
               */
              const payload = yield* Effect.result(
                HttpServerRequest.schemaBodyJson(SubmitMessagePayload),
              );
              if (Result.isFailure(payload)) {
                return HttpServerResponse.text(
                  "expected a JSON body of { text: string, author?: string }",
                  { status: 400 },
                );
              }

              const result = yield* thread.submit({
                author: payload.success.author ?? "anonymous",
                text: payload.success.text,
              });

              return yield* HttpServerResponse.json(result, {
                status: getResultStatus(result),
              });
            }

            case "read": {
              const after = Number(url.searchParams.get("after") ?? "0");
              const limit = url.searchParams.get("limit");

              const result = yield* thread.read(
                Number.isFinite(after) ? after : 0,
                limit === null ? undefined : Number(limit),
              );

              return yield* HttpServerResponse.json(result);
            }

            /**
             * Forced eviction, and the only route here that is not part of the
             * product.
             *
             * `state.abort()` destroys the instance that is serving this very
             * RPC, so the call cannot return — the rejection *is* the
             * confirmation. A clean return would mean the abort never took,
             * and every "survives eviction" assertion downstream of it would
             * then be vacuous. So the two outcomes are reported apart, rather
             * than collapsed into the 500 that an unhandled rejection would
             * otherwise produce.
             *
             * The Worker is a different isolate and is untouched by the abort,
             * which is why it is still here to answer.
             */
            case "evict": {
              const outcome = yield* Effect.exit(thread.evict());
              return yield* HttpServerResponse.json(
                EvictionOutcomeSchema.make({
                  aborted: Exit.isFailure(outcome),
                }),
              );
            }
          }
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError("unhandled request failure", cause),
            HttpServerResponse.text("internal server error", { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}

const SubmitMessagePayload = Schema.Struct({
  text: Schema.String,
  author: Schema.optional(Schema.String),
});

export const EvictionOutcomeSchema = Schema.Struct({
  aborted: Schema.Boolean,
});

const ACTIONS = ["submit", "read", "evict"] as const;

type ThreadRoute = {
  readonly threadId: string;
  readonly action: (typeof ACTIONS)[number];
};

const matchThreadRoute = (pathname: string): ThreadRoute | null => {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length !== 3 || segments[0] !== "threads") return null;

  const [, threadId, action] = segments;
  if (threadId === undefined || threadId === "") return null;
  if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) return null;

  return { threadId, action: action as (typeof ACTIONS)[number] };
};

const getResultStatus = SubmitResultSchema.match({
  Accepted: () => 200,
  EntryTooLarge: () => HttpApiError.PayloadTooLarge.status,
});
