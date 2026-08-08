import * as Cloudflare from 'alchemy/Cloudflare';
import { Schema } from 'effect';
import * as Effect from 'effect/Effect';

const EchoSchema = Schema.Struct({
  text: Schema.String,
  seq: Schema.Number,
  sessionId: Schema.String,
});

export class Echo extends Schema.Class<Echo>('Echo')(EchoSchema) {
  static formatEcho(text: string) {
    const formatted = text.trim().replace(/\s+/g, ' ');
    return formatted;
  }
}

/**
 * Phase 0 stand-in for `SessionDO`.
 * Note the two-phase shape Alchemy requires. The outer `Effect.gen` resolves
 * shared dependencies and the instance state *reference*. The inner effect is
 * the per-instance closure, and is the only place the state's
 * `RuntimeContext`-coloured methods (`storage.get`, `storage.put`) can
 * actually run.
 */
export default class Session extends Cloudflare.Workers.DurableObject<Session>()(
  'Sessions',
  Effect.gen(function* () {
    const state = yield* Cloudflare.Workers.DurableObjectState;

    return Effect.sync(() => {
      const sessionId = state.id.toString();

      /**
       * Read-increment-write against durable storage. If this survives a
       * Worker eviction between calls, the runtime boundary is real — which
       * is exactly the Phase 0 exit criterion.
       */
      const nextSeq = Effect.gen(function* () {
        const previous = (yield* state.storage.get<number>('seq')) ?? 0;
        const seq = previous + 1;
        yield* state.storage.put('seq', seq);
        return seq;
      });

      return {
        echo: (text: string) =>
          Effect.gen(function* () {
            const seq = yield* nextSeq;
            const reply: Echo = { text: Echo.formatEcho(text), seq, sessionId };
            return reply;
          }),

        currentSeq: () =>
          Effect.gen(function* () {
            return (yield* state.storage.get<number>('seq')) ?? 0;
          }),
      };
    });
  }),
) {}
