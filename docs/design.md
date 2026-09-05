# Design

The design documents live here, copied from the Kwicherbelliaken vault alongside
the thinking that produced them:

- **[`sdd.md`](./sdd.md)** — the software design document: problem, requirements,
  constraints, module design, the nine delivery phases with their exit tests,
  risks, and test specifications. **This is the one to change when the design
  changes**, and the copy in the vault follows it rather than the other way
  round.
- **[`event-log-thesis.md`](./event-log-thesis.md)** — the architectural
  argument, in prose. Historical: it is the reasoning that produced the SDD, not
  a document kept current. Where the two disagree, the SDD wins.
- **[`references.md`](./references.md)** — the working links. The full annotated
  bibliography stays in the vault as `Hal References.md`.

This file is the short form: where we are, and which decisions are settled.

## Where we are

**Phase 1 — the spine, in progress.** Phase 0 was delivered on 2026-08-02 (the
SDD records how). Phase 1 began with the merge of
["Thread" Instead of "Session" For Transcript Storage](https://github.com/slackermorris/hal-goodly/pull/1)
on 2026-09-05, which replaced the echo with the log the whole design rests on.

Exit criterion for Phase 1: two clients, one thread. Kill one mid-exchange; on
reconnect it replays exactly what it missed, in order, with correct attribution.

What is in place:

- `EventLog` owns the `events` table and is its only writer. Append gates on the
  1.8 MB row cap, read replays from a cursor with a limit, and a row the current
  schema cannot decode costs one counted entry rather than the whole replay.
- `Event` is a discriminated union with one kind, `message`. One schema serves
  the SQLite row, the domain object, and the derived JSON wire shape.
- `Thread` owns one `EventLog` and exposes intents, not log operations: submit,
  read, evict. `Api` routes `/threads/:id/{submit,read,evict}` to it.
- The integration suite proves write-then-read, two authors in order, the exact
  cap boundary, and that `seq` and state survive a forced eviction.

What is still to do before the exit test can even be written:

- Hibernating WebSocket fan-out. No `upgrade` path, no socket set.
- Participants and attribution carried in socket attachments rather than a
  trusted body field.
- The replay-then-subscribe join, which the SDD names as the only genuinely racy
  part of the fan-out.
- `head`, and the concurrency test for gapless monotonic `seq`.

Known open items carried from PR #1: `nextCursor` on an empty page, and `evict`
being an unauthenticated route.

The phases, in order. Each has an exit test; none is started before the previous
one passes. The ordering is deliberate — **the log and the telemetry come before
the intelligence**, because neither can be retrofitted and neither needs a model
to validate.

| Phase                       | Scope                                                                                      | Exit test                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation** — _done_ | Monorepo, Effect 4, Alchemy 2, one Worker, one Durable Object                              | An echo round-trips through an Effect runtime at a DO entrypoint, bindings typed end to end                                        |
| **1 — The spine** ← _here_  | `EventLog`, `Thread`, hibernating socket fan-out, replay from cursor, participants. No AI. | Two clients, one thread. Kill one mid-exchange; on reconnect it replays exactly what it missed, in order, with correct attribution |
| **2 — Observability**       | `Telemetry`, `effort.*` conventions, OTel export, local effort query                       | A span tree for a whole thread with effort attributed per span                                                                     |
| **3 — First turn**          | `ModelGateway`, `TurnLoop`, deltas batched into the log, compaction                        | A streamed conversation that survives a mid-stream disconnect, with token cost visible                                             |
| **4 — Lifecycle**           | `SandboxLease` under scope, TTL reaper, `TaskDO`, `DurableStep`                            | Kill the fiber mid-run: no orphan container. Evict the DO: the reaper catches it. Resume: completed steps do not re-run            |
| **5 — First real task**     | `SecretBroker`, `AgentRegistry`, git capability                                            | A merged PR where the sandbox never held a credential                                                                              |
| **6 — Gates**               | `Gate`, lint/typecheck/test gates, preview screenshots, `ArtifactStore`                    | A PR carrying its own evidence, and a failing gate whose findings drive a successful retry                                         |
| **7 — Adversarial review**  | `ReviewPanel`, lenses, refute-by-default, `mr-review` skill                                | A panel catching a defect the deterministic gates passed, with per-lens cost recorded                                              |
| **8 — Autonomy**            | `ScheduleRunner`, `WebhookIngress`, `Notifier`                                             | An external event, no human at the start, produces a reviewable PR and a notification                                              |

Phases 0–2 are committed scope. Later phases are designed in the SDD so the log
schema does not have to migrate, but are not commitments.

## Decisions already made, so they are not relitigated

- **No Cloudflare Agents SDK.** Everything it provides is what we are building.
  Understanding the primitives is a project goal, not a side effect.
- **No Workers Workflows.** Durable execution is a checkpoint table plus alarms
  on a Durable Object — which is a primitive small enough to own, and which
  composes with Effect's interruption semantics instead of discarding them at
  every step boundary. The escape hatch is preserved for a sub-agent that needs
  to sleep for weeks, as long as it stays off the streaming path.
- **Alchemy 2 for both infrastructure and Cloudflare runtime.** This is a change
  from the SDD as first written, which assumed a separate Effect–Cloudflare
  integration layer alongside Alchemy for IaC only. Alchemy 2 covers both, and
  covers the four boundaries the SDD flagged as missing — containers, object
  storage, inference, and browser rendering. One dependency instead of two
  overlapping ones.
- **Three Durable Object tiers**, split by natural lifetime: one per human, one
  per conversation (owns the log), one per task (owns exactly one sandbox).
  Keyed by session rather than user, so a conversation can have participants.
- **The event is a discriminated union from the start**, even while `message` is
  the only kind. The first use case is user-supplied messages (think Chat UI);
  the kinds that follow are sub-agent operations, reports from background tasks,
  and tool call output. The union's `Encoded` side is a SQLite row and its
  `Type` side is the runtime event, as established at the Durable Object RPC
  boundary — so adding a kind is a schema change and never a storage migration.
