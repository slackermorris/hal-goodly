import * as Cloudflare from "alchemy/Cloudflare";
import { Schema } from "effect";
import * as Effect from "effect/Effect";
import * as EventLog from "./EventLog.ts";

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

export default class Thread extends Cloudflare.Workers.DurableObject<Thread>()(
  "Threads",
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.gen(function* () {
      const threadId = state.id.toString();
      const log = yield* EventLog.make(state.storage.sql);

      const sessions = new Map<string, Cloudflare.WebSocket>();

      for (const socket of yield* state.getWebSockets()) {
        const data = socket.deserializeAttachment<{ id: string }>();
        if (data) sessions.set(data.id, socket);
      }

      const broadcast = (text: string) =>
        Effect.gen(function* () {
          for (const peer of sessions.values()) {
            yield* peer.send(text);
          }
        });

      return {
        fetch: Effect.gen(function* () {
          const [response, socket] = yield* Cloudflare.upgrade();

          const id = crypto.randomUUID();
          // Persist a JSON-safe value alongside the socket. Kept across hibernation.
          socket.serializeAttachment({ id });
          sessions.set(id, socket);

          return response;
        }),
        webSocketMessage: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          message: string | ArrayBuffer,
        ) {
          const attachment = socket.deserializeAttachment<{ id: string }>();
          if (!attachment) return;
          const text =
            typeof message === "string"
              ? message
              : new TextDecoder().decode(message);

          // [ ] TODO: remove this magic isolating of the id
          const label = attachment.id.slice(0, 8);
          yield* broadcast(`[${label}] ${text}`);
        }),

        webSocketClose: Effect.fn(function* (
          socket: Cloudflare.WebSocket,
          code: number,
          reason: string,
        ) {
          const attachment = socket.deserializeAttachment<{ id: string }>();
          if (attachment) sessions.delete(attachment.id);
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
