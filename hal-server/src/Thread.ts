import * as Cloudflare from 'alchemy/Cloudflare';
import { Schema } from 'effect';
import * as Effect from 'effect/Effect';
import * as EventLog from './EventLog.ts';

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

/**
 * The write gate's verdict, as data.
 *
 * Typed failures cannot cross the RPC boundary — an `Effect` failure arrives
 * at the caller as an opaque `RpcCallError` with the tag flattened away, so
 * `catchTag` in the Worker would never match and a legitimate rejection would
 * be indistinguishable from a defect. Rejections are therefore caught inside
 * the object and returned, which is the same shape Alchemy's own Durable
 * Object fixtures use.
 */
export type SubmitResult =
  | { readonly _tag: 'Accepted'; readonly receipt: EventLog.Receipt }
  | {
      readonly _tag: 'Rejected';
      readonly reason: 'EntryTooLarge';
      readonly bytes: number;
      readonly limit: number;
    };

/**
 * Scaffolding for the Phase 0/1 exit tests. `incarnation` changes every time
 * Cloudflare reconstructs the instance, which is the only way an eviction test
 * can prove the isolate actually died rather than passing silently because one
 * instance served both halves of the test.
 *
 * Gate or delete this before Phase 5 — `evict` in particular is a denial of
 * service handed out over RPC.
 */
export type Diagnostics = {
  readonly incarnation: string;
  /** Deliberately in-isolate: the negative control for the eviction test. */
  readonly memoryAppends: number;
  readonly rows: number;
  /** Must be null once the cutover away from KV storage is complete. */
  readonly kvSeq: number | null;
  readonly databaseSize: number;
};

export default class Thread extends Cloudflare.Workers.DurableObject<Thread>()(
  'Threads',
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.gen(function* () {
      const threadId = state.id.toString();
      const log = yield* EventLog.make(state.storage.sql);

      /**
       * Both of these live in isolate memory and are therefore lost on
       * eviction. That is not a bug to fix — it is the property the eviction
       * tests assert against, standing in for every piece of runtime state
       * that must never become a source of truth.
       */
      const incarnation = crypto.randomUUID();
      let memoryAppends = 0;

      const append = (input: {
        readonly kind: string;
        readonly author: string;
        readonly payload: unknown;
        readonly clientMsgId?: string | undefined;
      }) =>
        Effect.tap(log.append(input), (receipt) =>
          Effect.sync(() => {
            if (!receipt.deduplicated) memoryAppends += 1;
          }),
        );

      return {
        /**
         * A participant contributes to the conversation. Deliberately not
         * `append(event)`: the caller states an intent and the log decides
         * what entry that becomes.
         */
        submit: (input: {
          readonly author: string;
          readonly text: string;
          readonly clientMsgId?: string | undefined;
        }) =>
          append({
            kind: 'message',
            author: input.author,
            payload: { text: input.text },
            clientMsgId: input.clientMsgId,
          }).pipe(
            Effect.map((receipt) => ({ _tag: 'Accepted', receipt }) satisfies SubmitResult),
            Effect.catchTag('EntryTooLarge', (error) =>
              Effect.succeed({
                _tag: 'Rejected',
                reason: 'EntryTooLarge',
                bytes: error.bytes,
                limit: error.limit,
              } satisfies SubmitResult),
            ),
            /**
             * `submit` only ever writes the `message` kind, so an unknown kind
             * here is a programming error rather than bad input — it dies as a
             * defect instead of being dressed up as a rejection.
             */
            Effect.orDie,
          ),

        /**
         * Phase 0's exit criterion, preserved and now standing on the log:
         * `seq` is the row's own primary key rather than a counter kept beside
         * it, so the number in the reply is a receipt for a durable entry.
         */
        echo: (text: string) =>
          Effect.gen(function* () {
            const formatted = Echo.formatEcho(text);
            const receipt = yield* Effect.orDie(
              append({
                kind: 'echo',
                author: 'anonymous',
                payload: { text: formatted },
              }),
            );
            const reply: Echo = {
              text: formatted,
              seq: receipt.seq,
              threadId,
            };
            return reply;
          }),

        /**
         * Replay from a cursor. `after` is exclusive.
         *
         * Annotated here rather than inside the log: the log does not know
         * which thread holds it, and should not have to.
         */
        read: (after: number, limit?: number) =>
          Effect.annotateLogs(log.read(after, limit), { threadId }),

        head: () => log.head,

        diagnostics: () =>
          Effect.gen(function* () {
            const kvSeq = yield* state.storage.get<number>('seq');
            return {
              incarnation,
              memoryAppends,
              rows: yield* log.count,
              kvSeq: kvSeq ?? null,
              databaseSize: state.storage.sql.databaseSize,
            } satisfies Diagnostics;
          }),

        /**
         * Tears the instance down: in-flight work fails, the isolate is
         * discarded, and the next request reconstructs from durable storage.
         * This is the closest thing to a deterministic eviction, and it exists
         * so the tests do not have to wait for Cloudflare to evict on its own
         * schedule.
         */
        evict: () => state.abort('forced eviction'),
      };
    });
  }),
) {}

const EchoSchema = Schema.Struct({
  text: Schema.String,
  seq: Schema.Number,
  threadId: Schema.String,
});

export class Echo extends Schema.Class<Echo>('Echo')(EchoSchema) {
  static formatEcho(text: string) {
    const formatted = text.trim().replace(/\s+/g, ' ');
    return formatted;
  }
}
