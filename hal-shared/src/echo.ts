import { Schema } from 'effect';

/**
 * The Phase 0 contract. Deliberately trivial: its job is to prove that a
 * schema defined once in `hal-shared` is the same schema the Worker, the
 * Durable Object, and the tests all agree on.
 *
 * Phase 1 replaces this with the session event log. See `docs/design.md`.
 */
export const EchoRequest = Schema.Struct({
  text: Schema.String,
});

export type EchoRequest = Schema.Schema.Type<typeof EchoRequest>;

export const EchoReply = Schema.Struct({
  /** The echoed text, formatted by {@link formatEcho}. */
  text: Schema.String,
  /**
   * Monotonic per-session counter, read from and written back to Durable
   * Object storage. This is the part that proves the Effect runtime is
   * genuinely talking to durable state rather than in-memory state that
   * happens to survive one request.
   */
  seq: Schema.Number,
  /** The Durable Object instance id that served the request. */
  sessionId: Schema.String,
});

export type EchoReply = Schema.Schema.Type<typeof EchoReply>;

/**
 * Pure formatting, kept out of the Durable Object so it can be tested
 * without a runtime. Trims and collapses whitespace so the reply is stable.
 */
export const formatEcho = (text: string): string => text.trim().replace(/\s+/g, ' ');
