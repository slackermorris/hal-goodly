import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as EventLog from "./EventLog.ts";
import { encodeEventFrame, Event } from "./Event.ts";

/**
 * One conversation. Formerly `SessionDO`, and renamed for two reasons.
 *
 * "Session" carries the wrong lifetime — in web vocabulary it is a connection
 * that starts at login and dies with the tab, whereas this object is
 * specifically the thing that *outlives* a connection so that a dropped client
 * gets a bookmark rather than a hole. The `Api` Worker will also terminate
 * Cloudflare Access, which has sessions in the other sense, so the two
 * meanings would have sat one directory apart.
 *
 * And the Cloudflare Agents SDK — the closest prior art in this exact domain —
 * uses `Session` for a conversation stored *inside* an agent, many per
 * instance. Keeping the word here would have inverted the cardinality for
 * anyone reading both.
 *
 * A `Thread` owns exactly one {@link EventLog} and everything that surrounds
 * it: the socket set and its hibernation attachments (Phase 1), participants
 * and attribution, the turn loop (Phase 3), and dispatch to tasks (Phase 4).
 * The division of labour is that **the log decides what is true and the thread
 * decides who gets told.**
 *
 * The thread is also the serialisation point, and that is load-bearing rather
 * than incidental. A Durable Object turn does not yield, so attaching a socket
 * and reading the log's head happen atomically with respect to any append —
 * which is what makes replay-then-subscribe safe without a buffer or a lock,
 * and is the strongest argument for the sockets living with the log instead of
 * one tier up on the agent.
 *
 * The public surface is intents, not log operations. There is no `append`,
 * because the log is the only writer of conversation truth and a generic
 * append would hand that role to every caller.
 *
 * Note the two-phase shape Alchemy requires. The outer `Effect.gen` resolves
 * shared dependencies and the instance state *reference*. The inner effect is
 * the per-instance closure, and is the only place the state's
 * `RuntimeContext`-coloured methods can actually run — which is also why it
 * re-runs every time Cloudflare reconstructs the instance.
 */

export const SubmitResultSchema = Schema.TaggedUnion({
  Accepted: { receipt: EventLog.AppendResponseSchema },
  EntryTooLarge: { bytes: Schema.Number, limit: Schema.Number },
});

export type SubmitResult = typeof SubmitResultSchema.Type;

/**
 * Headers the `Api` Worker sets on the forwarded upgrade request once it has
 * resolved who is connecting. The object trusts them because only the Worker
 * can reach it.
 */
export const AUTHOR_HEADER = "x-hal-author";
export const CLIENT_HEADER = "x-hal-client";
export const CURSOR_HEADER = "x-hal-cursor";

/**
 * What rides along with a hibernated socket. Three ids for three lifetimes:
 *
 * - `socketId` is one connection, minted here at upgrade. It keys the session
 *   set, so closing one tab never drops another.
 * - `clientId` is one device or tab, minted by the client and stable across
 *   reconnects.
 * - `author` is the human, and is what attribution shows and the log stores.
 *
 * The attachment is serialised into the hibernation record, which is capped
 * at 2 KB, so it stays at these fields.
 */
type Attachment = {
  readonly socketId: string;
  readonly clientId: string;
  readonly author: string;
};

export default class Thread extends Cloudflare.Workers.DurableObject<Thread>()(
  "Threads",
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.gen(function* () {
      const threadId = state.id.toString();
      const log = yield* EventLog.make(state.storage.sql);

      const sessions = new Map<string, Cloudflare.WebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<Attachment>();
        if (data) sessions.set(data.socketId, socket);
      }

      /**
       * Fan one persisted event out to every live socket. Takes the domain
       * event, not a string: what peers receive is the row the log holds, with
       * its `seq`, encoded once through the same frame codec replay uses.
       */
      const broadcast = (event: typeof Event.Type) =>
        Effect.gen(function* () {
          const frame = encodeEventFrame(event);
          for (const peer of sessions.values()) {
            yield* peer.send(frame);
          }
        });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const author = Headers.get(request.headers, AUTHOR_HEADER);
          const clientId = Headers.get(request.headers, CLIENT_HEADER);
          const cursor = Headers.get(request.headers, CURSOR_HEADER);

          if (
            Option.isNone(author) ||
            Option.isNone(clientId) ||
            Option.isNone(cursor)
          ) {
            return HttpServerResponse.text("socket identity headers missing", {
              status: 500,
            });
          }

          const [response, socket] = yield* Cloudflare.upgrade();

          const after = Number(cursor.value);

          const page = yield* log.read(after);
          for (const event of page.events) {
            yield* socket.send(encodeEventFrame(event));
          }

          const attachment: Attachment = {
            socketId: crypto.randomUUID(),
            clientId: clientId.value,
            author: author.value,
          };
          // Persisted alongside the socket; kept across hibernation.
          socket.serializeAttachment(attachment);
          sessions.set(attachment.socketId, socket);

          return response;
        }),

        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<Attachment>();
          if (!attachment) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);

          const input = {
            kind: "message",
            author: attachment.author,
            payload: { text },
          } as const;

          const result = yield* log.append(input).pipe(
            Effect.map((receipt) =>
              SubmitResultSchema.cases.Accepted.make({ receipt }),
            ),
            Effect.catchTag("EntryTooLarge", (error) =>
              Effect.succeed(
                SubmitResultSchema.cases.EntryTooLarge.make({
                  bytes: error.bytes,
                  limit: error.limit,
                }),
              ),
            ),
          );

          if (result._tag === "Accepted") {
            yield* broadcast({ ...input, ...result.receipt });
          }
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = socket.deserializeAttachment<Attachment>();
          if (attachment) sessions.delete(attachment.socketId);
          yield* socket.close(code, reason);
        }),

        broadcast,

        submit: (input) =>
          log
            .append({
              kind: "message",
              author: input.author,
              payload: { text: input.text },
            })
            .pipe(
              Effect.map((receipt) =>
                SubmitResultSchema.cases.Accepted.make({ receipt }),
              ),
              Effect.catchTag("EntryTooLarge", (error) =>
                Effect.succeed(
                  SubmitResultSchema.cases.EntryTooLarge.make({
                    bytes: error.bytes,
                    limit: error.limit,
                  }),
                ),
              ),
            ),

        read: (after: number, limit?: number) =>
          Effect.annotateLogs(log.read(after, limit), { threadId }),

        /**
         * Tears the instance down: in-flight work fails, the isolate is
         * discarded, and the next request reconstructs from durable storage.
         * This is the closest thing to a deterministic eviction, and it exists
         * so the tests do not have to wait for Cloudflare to evict on its own
         * schedule.
         */
        evict: () => state.abort("forced eviction"),
      };
    });
  }),
) {}
