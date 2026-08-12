# Hal — Software Design Document

> Copied from the Kwicherbelliaken vault (`Hal SDD.md`, written 2026-08-01). Names
> in _italics_ were vault links to notes that do not live in this repository —
> earlier attempts, source captures, and reading. External sources are listed in
> [`references.md`](./references.md).

Software design document for **Hal**, the third attempt at _Hal Good_. The architectural
thesis is argued separately in
[the event log thesis](./event-log-thesis.md); this
document is the buildable form of it. Bibliography lives in [`references.md`](./references.md).

Supersedes _Personal agent on Cloudflare — architecture and decisions_ and the
prototype whose post-mortem is _Redesign Needing More Fit For Purpose Agent Workflows_.

## Problem

I want one agent I can talk to from any device that can take a real piece of work — "fix
this bug in that repo" — and drive it to a reviewable pull request without me babysitting
it. Two previous attempts stalled, for reasons that are now diagnosable rather than vague.

**From the operator's perspective**, the prototype could hold a conversation but could not
do anything. Its one sub-agent path was commented out before it ever ran end to end. When
a task was dispatched there was no way to see where time or money went, no way to resume a
dropped stream, and no way to trust that a container had been cleaned up.

**From the builder's perspective**, the deeper problem was structural: **there was no
single durable thing the system agreed to write to.** State was spread across workflow
step results, Durable Object storage, the WebSocket wire, and the model provider's own
logs, and none of those could see each other. Every symptom traces back to that. Streaming
fought durable execution because they were different substrates. Effort was unmeasurable
because no two legs of the system shared an identifier. Resumption was impossible because
nothing was ordered. Lifecycle was murky because one Durable Object per user held
everything at once, so nothing had a bounded lifetime.

There is a third problem, and naming it honestly matters because it shapes every decision
below: **the prototype delegated its own architecture to a framework.** It ran on a chat
agent base class that owned message persistence, stream shape, and scheduling. That was
fine for a demo and fatal for understanding. The stated goal of this project is to
understand the primitives, and the previous attempt's own conclusion was that the
disappointing part was suspecting these patterns couldn't be built by hand.

## Requirements

**R1 — Multiplayer chat across devices.** Reachable from laptop and phone. Multiple clients
share one conversation with live state. Every message attributed to its author. A client
that drops and reconnects sees what it missed rather than a hole.

**R2 — Strong lifecycle control of resources.** Every sandbox has exactly one owner and a
bounded lifetime. No orphaned containers under any exit path, including crash and
eviction. Conversation storage must not grow without bound.

**R3 — Orchestration to sandboxed sub-agents.** The orchestrator delegates to sub-agents
that run in sandboxes with a real OS: pull down code, change it, run the test suite, drive
a browser, record what changed as durable evidence. Work must pass quality gates before it
reaches me. Gates are codified as reusable, versioned skills — `mr-review` is the worked
example. Code review uses an adversarial pattern across several independent agents.

**R4 — Heavy OTel instrumentation showing where effort is spent.** Not "what happened" but
"what did that cost". Tokens, wall time, sandbox seconds, retries, and gate failures,
attributed to thread, task, agent type, gate, and model.

**R5 — Effect TS**, as the language for the whole system rather than a utility library in
one corner.

**R6 — Alchemy** for infrastructure, so infra is described in Effect and the resources it
returns are the ones the program consumes.

**R7 — Async work and durable resumption.** Long tasks return control immediately. The
system sleeps, wakes, reports the outcome to whichever surface I'm on, and supports
scheduled and recurring work.

## Constraints

**C1 — New repository, no agent framework.** Decided explicitly. Hal is built from
primitives; the chat agent base class, its persistence, its routing, and its workflow
helpers are all out. This is the largest cost accepted in this document and it is accepted
deliberately.

**C2 — Effect v4, in beta.** The sibling project runs `effect@4.0.0-beta.65` with the
Effect language service. Hal cannot match that pin exactly: Alchemy 2 requires
`effect >= 4.0.0-beta.100`, so Hal is on `4.0.0-beta.102`. Same major, same idiom, same
language service — but "identical to the sibling project" is not available, and the two
will drift further. The API surface can move under us and there is little published prior
art.

**C3 — Cloudflare platform, and the isolate cannot exec.** No long-lived servers. The V8
isolate has no process model — no `spawn`, no test runner, no dev server. Anything that
runs a build or a suite must run in a container, which costs hundreds of milliseconds to
start and is billed by the second.

**C4 — Single operator on a personal budget.** Cost is a design constraint, not an
afterthought. An agent that can spawn agents in per-second-billed containers is a genuine
financial risk.

**C5 — Established toolchain conventions.** Match the sibling project: workspace monorepo
split server / client / shared, oxlint with type-aware linting plus oxfmt (not
ESLint/Prettier), Vitest, and the settled Effect idiom of a tagged service class with its
layer exported separately and errors as tagged error classes.

**C6 — Container concurrency is capped.** The prototype's ceiling was five instances. Any
fan-out design — and an adversarial review panel is fan-out by definition — has to queue
against a small number, not assume elasticity.

**C7 — Learning is a first-class goal.** The design must leave the primitives visible.
This constraint is what makes C1 rational: a convenience layer that hides Durable Object
storage, hibernation, and alarms defeats the purpose of building it.

---

## Hal

### 1. Executive Summary

Hal is a personal engineering agent on Cloudflare, written in Effect, whose architecture
rests on one primitive: **an append-only, ordered event log per thread, held in Durable
Object SQLite.** Streaming, multiplayer, reconnection, durable task resumption, effort
accounting, and change recording are all projections of that one log rather than separate
mechanisms — which is precisely what the previous two attempts lacked and why they each
stalled in a different place.

Three tiers of Durable Object give resources bounded lifetimes: a near-immortal object per
human, one per conversation that owns the log and fans out to sockets, and an ephemeral
one per delegated task that owns exactly one sandbox. Sub-agents are Effect values whose
type signature declares their privileges, so a reviewer that tries to reach for write
access fails to compile. Workers Workflows are deliberately not used; durable execution is
a checkpoint table plus alarms, which is a primitive small enough to own.

**The biggest risk is not architectural, it is compound novelty.** Effect v4 in beta,
Alchemy 2 in beta supplying _both_ the infrastructure and the Cloudflare runtime,
Cloudflare's own young agent primitives, and a from-scratch rebuild of everything the
framework previously provided — all at once, by one person. The mitigation is the phase
plan: the first three phases contain no AI at all and exist purely to falsify the
foundation cheaply. If Effect inside a hibernating Durable Object is miserable, that is
discoverable in a week on an echo server rather than in a quarter on a half-built agent.

### 2. Solution Overview

Think of Hal as a **ship's log rather than a conversation**. A conversation exists only
between the people currently in the room; when someone leaves and returns, it is gone. A
log is written once, in order, and anyone can pick it up and read forward from wherever
they stopped. Two officers reading the same log stay in sync without talking to each
other. A log read a month later still says what happened, and — because each entry is
stamped — it also says how long each thing took and what it consumed.

That reframing is the whole design. The sub-agent doing work does not send progress _to
you_; it writes entries. Your laptop, your phone, the task state machine, and the
telemetry pipeline are all just readers at different positions. Nothing needs to know who
else is watching, which is why multiplayer costs almost nothing to add, and why a dropped
connection is a bookmark rather than a failure.

The second idea is **capability handoff**. A sub-agent is not given a machine and told what
not to touch; it is handed exactly the abilities its job requires and has no way to express
anything else. A reviewer receives the ability to read a diff and to write findings — not
the ability to commit. This is enforced by the type system, not by instructions in a
prompt, which matters because prompts can be talked out of things.

```
                        Cloudflare Access (Zero Trust)
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
   Web client                   Webhook ingress            Terminal client
   (laptop, phone)              Linear / GitHub /          (roaming, optional)
   WebSocket + cursor           Slack — signed
        │                            │                            │
        └────────────────┬───────────┴────────────────────────────┘
                         │
                 ┌───────▼────────────────────────────────────┐
                 │  Entry Worker — Effect runtime boundary    │
                 │  auth, routing, normalise to work items    │
                 └───────┬────────────────────────────────────┘
                         │
      ┌──────────────────▼──────────────────────────────────────┐
      │  Agent — one per human · near-immortal, mostly idle     │
      │  identity · thread index · notify channels · schedule   │
      │  CONTROL PATH ONLY — never carries a message            │
      └──────────────────┬──────────────────────────────────────┘
                         │ resolves which thread
      ┌──────────────────▼──────────────────────────────────────┐
      │  Thread — one per conversation                          │
      │  ★ EVENT LOG (SQLite, ordered by seq)                   │
      │    participants + attribution                           │
      │    WebSocket hibernation fan-out · replay from cursor   │
      │    turn loop                                            │
      └──────────────────┬──────────────────────────────────────┘
                         │ dispatches (registry lookup + props)
      ┌──────────────────▼──────────────────────────────────────┐
      │  Task — one per delegated task · ephemeral              │
      │  checkpoint table · alarms · TTL reaper                 │
      │  owns exactly ONE sandbox lease                         │
      └──────────────────┬──────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   plan sandbox    implement sandbox   verify sandbox × N
   read-only       full stack,         browser + Playwright,
   small           runs the suite      adversarial lenses
        │                │                │
        └────────────────┼────────────────┘
                         │  ALL egress
                 ┌───────▼──────────────────────────────┐
                 │  Secret Broker (Outbound Worker)     │
                 │  host allowlist · secret templating  │
                 │  agent never holds a credential      │
                 └───────┬──────────────────────────────┘
                         │
   ┌─────────────┬───────┴────────┬──────────────┬─────────────────┐
   ▼             ▼                ▼              ▼                 ▼
 AI Gateway    D1 registry      R2            Artifacts      OTel collector
 tokens/cost   capability      diffs,         skill           spans carrying
 per call      descriptors     screenshots,   packages        effort.* attrs
               (never values)  traces         (versioned)
```

#### Modules

Everything is new, so the useful distinction is **borrowed versus built** — and that split
is also the honest map of where the risk sits.

**Correction from the first draft of this document.** That draft assumed two dependencies:
Alchemy for infrastructure, and a separate third-party Effect–Cloudflare integration layer
(`effect-cf`) for the runtime. That was wrong. **Alchemy 2 is both** — "infrastructure as
Effects" extends to the runtime, so the same package that declares a Durable Object also
supplies its Effect-native state, storage, alarms, hibernating sockets and `upgrade`, plus
containers, R2, KV, Queues, AI Gateway, Artifacts and the Worker Loader. Two consequences,
both good: one dependency instead of two with overlapping Durable Object abstractions, and
**the four boundaries this document previously flagged as unwrapped are covered.** The
`effect-cf` dependency and its associated risk are struck.

| Module             | Owns                                                                                                                                | Borrowed / built                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **InfraStack**     | Every Cloudflare resource declared in Effect; exports the typed handles the app consumes                                            | Alchemy                            |
| **EventLog** ★     | Append, read-from-cursor, head. The events schema. The only writer of conversation truth                                            | Built on borrowed DO storage       |
| **Telemetry**      | Span conventions, the `effort.*` attribute set, correlation ids joining spans to gateway records                                    | Built on Effect's tracer           |
| **Capabilities**   | The tagged interfaces sub-agents depend on — read a diff, exec in a sandbox, use git, drive a browser. _This is the security model_ | Built                              |
| **SandboxLease** ★ | Acquire/release of one sandbox flavour, scope-bound, plus an independent reaper                                                     | Built on borrowed containers       |
| **SecretBroker** ★ | Egress allowlist and credential substitution at the network layer                                                                   | Built (separate Worker)            |
| **AgentRegistry**  | Capability descriptors per agent type: model, flavour, allowed hosts, secret _names_                                                | Built on borrowed D1               |
| **ModelGateway**   | Model calls through AI Gateway as an Effect service, streaming deltas to a log                                                      | Built on borrowed AI Gateway       |
| **Thread**         | Owns one `EventLog`; socket fan-out, participants, turn loop. One per conversation                                                  | Built on borrowed DO + hibernation |
| **Task**           | Durable state machine for one task; owns one lease                                                                                  | Built on borrowed DO + alarms      |
| **Agent**          | Identity, thread index, notification channels, schedule table. The domain entry point, on the control path only                     | Built on borrowed DO + alarms      |
| **DurableStep**    | Run-once-and-remember, retry policy, resume after eviction. The workflow replacement                                                | Built                              |
| **TurnLoop**       | Assemble context from the log, call the model, stream deltas, dispatch tool calls                                                   | Built                              |
| **Dispatcher**     | Tool call → registry lookup → Task with unforgeable authorisation context                                                           | Built                              |
| **Gate** ★         | A quality gate as a value returning structured findings                                                                             | Built                              |
| **ReviewPanel**    | Independent lenses, refute-by-default, majority verdict, cost recorded per lens                                                     | Built                              |
| **SkillPackage**   | Resolve a versioned skill into a sandbox                                                                                            | Built on Artifacts                 |
| **ArtifactStore**  | Diffs, screenshots, traces, videos as durable evidence referenced from the log                                                      | Built on borrowed R2               |
| **ScheduleRunner** | Recurrence described declaratively, executed by an alarm                                                                            | Built                              |
| **WebhookIngress** | Signature verification; normalise external events into work items                                                                   | Built                              |
| **Notifier**       | Reach me when no socket is connected                                                                                                | Built                              |
| **Web client**     | Chat, cursor-based resume, and an effort view                                                                                       | Built                              |

Five modules are deep — a stable interface hiding real machinery, testable in isolation:
`EventLog`, `SandboxLease`, `SecretBroker`, `Gate`, `DurableStep`. Those five are where
design effort belongs.

Two are flagged as **suspiciously shallow** and should be resisted until they earn
themselves: `Notifier` is a thin wrapper over an outbound request and probably starts life
as a method on `Thread`; `SkillPackage` may be nothing more than a clone plus a schema
check, in which case it is a function, not a module. Adding indirection here would buy
nothing.

#### Delivery phases

Each phase has an exit test. The ordering is deliberate: **the log and the telemetry come
before the intelligence**, because neither can be retrofitted and neither needs a model to
validate.

| Phase                                       | Scope                                                                                          | Exit test                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **0 — Foundation** — _delivered, see below_ | Monorepo, Effect v4, Alchemy 2 stack provisioning one Worker and one Durable Object            | An echo round-trips through an Effect runtime at a DO entrypoint, with Alchemy-declared bindings typed end to end                  |
| **1 — The spine**                           | `EventLog`, `Thread`, hibernating socket fan-out, replay from cursor, participants. **No AI.** | Two clients, one thread. Kill one mid-exchange; on reconnect it replays exactly what it missed, in order, with correct attribution |
| **2 — Observability**                       | `Telemetry`, `effort.*` conventions, OTel export, local effort query over the log              | A span tree for a whole thread, with effort attributed per span. Costs are zero — the point is that the plumbing is proven         |
| **3 — First turn**                          | `ModelGateway`, `TurnLoop`, deltas batched into the log, **compaction** on turn end            | A real streamed conversation that survives a mid-stream disconnect, and whose token cost appears in the effort query               |
| **4 — Lifecycle**                           | `SandboxLease` under scope, TTL reaper, `Task`, `DurableStep`                                  | Kill the fiber mid-run: no orphan container. Evict the DO mid-run: the reaper catches it. Resume: completed steps do not re-run    |
| **5 — First real task**                     | `SecretBroker`, `AgentRegistry`, git capability, clone → change → push → PR                    | A merged pull request where the sandbox never held a credential, provable from the broker's logs                                   |
| **6 — Gates**                               | `Gate`, lint/typecheck/test gates, preview screenshots, `ArtifactStore`                        | A PR that arrives carrying its own evidence, and a failing gate whose structured findings drive a successful retry                 |
| **7 — Adversarial review**                  | `ReviewPanel`, lenses, refute-by-default, `SkillPackage` (`mr-review`)                         | A panel that catches a defect the deterministic gates passed, with per-lens cost recorded so the panel can be judged on value      |
| **8 — Autonomy**                            | `ScheduleRunner`, `WebhookIngress`, `Notifier`                                                 | An external event, with no human in the loop at the start, produces a reviewable PR and a notification                             |

Phases 0–2 are committed scope. Everything after is designed here so the log schema does
not have to migrate later, but is not a commitment.

**Compaction moved from Phase 1 to Phase 3**, and the earlier draft placing it in Phase 1
was a category error worth naming. Compaction is a **context window** mechanism, not a
storage one: the Agents SDK triggers it on a token threshold and writes summaries to a
table separate from the messages they summarise, which is a derived view rather than a
mutation of history. There is no context window before Phase 3 and therefore nothing for it
to do, and a Phase 1 log with no delete path is simpler in a way that shows up directly in
the read result — one shape rather than a `Replay` / `Truncated` union with a floor. The
cost is that R2's "conversation storage must not grow without bound" is unanswered until
Phase 3. Accepted: under C4 the operator is one person, and the growth driver is batched
token deltas, which arrive with the same phase that answers them.

#### Phase 0 — delivered, 2026-08-02

Scaffolded at `~/Code/hal-goodly` as a workspace monorepo on
`effect@4.0.0-beta.102` and `alchemy@2.0.0-beta.67`, with oxlint type-aware, oxfmt, and
Vitest 4. `npm run check` is green: format, lint, typecheck, and unit tests.

**Both halves of the exit criterion are met.**

- **"Bindings typed end to end" — proven by the typechecker rather than a test.**
  The Worker obtains its `Threads` client by yielding the same declaration that provisions
  the namespace, so a mismatch is a compile error. There is no wrangler config and no
  generated environment type in the repository at all.
- **"An echo round-trips" — running.** `npm run test:integration` stands the stack up in
  local workerd and drives it over HTTP, asserting that the echo comes back formatted, that
  the counter advances across requests on one thread, and that a different thread name is
  a different instance whose counter starts from its own zero. The `AuthError` that blocked
  it at first was exactly what it looked like: Alchemy resolves a Cloudflare account before
  planning even in local mode, so the suite needs credentials and is therefore opt-in —
  split from the unit run by file name, leaving `npm run check` credential-free.

Three findings worth carrying forward. The published Alchemy tag lags its repository
examples on where `DurableObject` and `Worker` live, so the installed type definitions are
the only reliable reference. The oxlint/tsgolint version pairing has moved on from the
sibling project's pins, which no longer resolve together. And **`hal-shared` was removed**:
C5's server/client/shared split was scaffolded before anything needed it, and an empty
package with a broken export map is worse than no package. It returns when the web client
gives it a second consumer.

### 3. Requirements Analysis

**R1 — Multiplayer across devices — ✅.** All sockets for a thread route to one Durable
Object, so shared state needs no coordination layer. Hibernation keeps idle connections
free, and Alchemy's hibernating socket wrapper carries serialisable attachments, which is
how author identity survives eviction — the exact problem that makes naive attribution
break. Reconnection is a cursor. Keying by thread rather than user is what allows a
conversation to have several participants; the prototype had already drifted this way, so
it is a small change.

The subtle part is not the fan-out but the **join**: a reconnecting client must be replayed
from its cursor and then attached to the live stream without dropping an entry between the
two or delivering one twice. A Durable Object turn does not yield, so attaching the socket
and reading the log's head are atomic with respect to any append — no buffer and no lock.
That property only holds while the sockets and the log sit in the same object, which is the
strongest argument for keeping the log on `Thread` rather than one tier up on `Agent`.

**R2 — Lifecycle control — ✅, with one caveat held open.** One task, one sandbox, one
owner, one lifetime. Scoped acquire/release guarantees the release runs on success,
failure, and interruption — that last case is the one that leaks in promise-based code.
**Conversation storage growth is, as of this revision, unanswered** — see the compaction
note under Phase 3 below. **The caveat: no runtime-level guarantee survives the DO
being evicted between acquire and release**, which is why an independent reaper alarm exists
rather than being treated as belt-and-braces paranoia. Both mechanisms are required; either
alone is insufficient.

**R3 — Sandboxed sub-agents with gates and adversarial review — ⚠️ satisfied in design, with
real work behind it.** Flavoured sandboxes (plan, implement, verify) come from the WorkOS
Horizon pattern, and the verify flavour runs as a _client_ of the implement sandbox's
preview URL rather than inside it — which is what makes verification structurally
adversarial rather than merely instructed. Gates are values returning structured findings.
Skills are versioned packages. The panel gives each reviewer a distinct lens and asks it to
refute.

Two honest gaps remain. **First, C6 caps container concurrency**, so the panel queues
rather than fanning out freely; with a cap of five, a four-lens panel plus an implement
sandbox saturates the account. Raising the cap or accepting serialised review is a decision
deferred to Phase 7 with real numbers in hand. **Second, "record the changes" is satisfied
by artifacts referenced from the log, but Playwright traces and video inside a container are
unproven on this platform** and want a spike before Phase 6 is costed.

A third gap has closed since the first draft. That draft counted containers, object storage,
inference and browser rendering as four boundaries to wrap by hand, and priced that into
Phases 4–6. Alchemy 2 provides all four, so that effort largely disappears — what remains is
composing them behind the capability interfaces, which is the work that was always going to
be ours.

**R4 — Effort observability — ✅, and stronger than a normal tracing setup.** Effect threads
a tracer through the call graph, so spans do not need manual context propagation across
boundaries. Two legs are correlated: spans carry the effort attribute set; the gateway
independently reports tokens and cost per call; a shared correlation id joins them.
Underneath both sits the log — durable, local, queryable, and independent of any vendor's
retention window. Sandbox seconds are treated as a first-class effort dimension alongside
tokens, because under C3 and C4 they may well dominate the bill.

**R5 — Effect throughout — ✅.** Effect is load-bearing rather than decorative, in four
specific places. Layers _are_ the capability model, which makes least privilege a
compile-time property. Scopes _are_ the lifecycle answer. Fibers give structured
cancellation, so "stop the agent" runs finalisers instead of leaking. And tracing is
built in rather than bolted on. Schema does quadruple duty across tool definitions,
structured model output, event encoding, and registry decoding.

**R6 — Alchemy — ✅ for provisioning, ⚠️ for evolution.** One Effect program declares
everything and returns the handles the app consumes, so there is no second source of truth
to drift. Ephemeral per-branch stacks become cheap, which matters because sandbox flavours
are themselves infrastructure. The caveat is **Durable Object migrations** — class renames
and SQLite schema changes are the sharp edge of any Cloudflare IaC, and with three DO
classes each holding real data this will need care and probably some hand-holding.

**R7 — Async work and durable resumption — ✅.** A task returns immediately; `Task` sets
an alarm, wakes, checks external state, appends, and either advances or re-arms. Sleeping
is free. Completion appends to the log, which fans out to live sockets and otherwise
notifies. Recurrence is a schedule table on `Agent` driven by a single alarm — a
declarative description executed by a durable executor.

### 4. Constraints Analysis

**C1 — no framework — respected, and the dominant source of design pressure.** Everything
the chat agent base class provided is now ours: message persistence, resumable streams,
socket lifecycle, state broadcast, scheduling. This is why the event log is the spine
rather than a nice-to-have — it is the one abstraction that replaces _all_ of those at
once, and that is the argument for the whole design. Note one correction to earlier
reasoning: the framework's workflow helper did provide a coarse progress channel back to
the agent, so it was not mute. The accurate objection is narrower — token-level streaming
cannot pass through a checkpointed step, and coarse status callbacks are not an ordered,
durable, replayable log.

**C2 — Effect v4 beta — respected in idiom, not in version.** Same major, same service and
error idiom, same language service — but `beta.102` rather than the sibling project's
`beta.65`, because Alchemy 2 floors Effect at `beta.100`. Accepted cost: little prior art,
breaking changes are possible, and the two projects will drift. Alchemy's own peer range is
`>= beta.100`, so Hal and its main dependency at least move together.

**C3 — isolate cannot exec — shapes the whole sub-agent tier.** This is why sub-agents are
containers and not isolates, why verification is a separate flavour, and why preview
screenshots go through a real deployed URL rather than a local server. Cheap one-shot
screenshots can come from the browser binding; genuine UI driving needs the container.

**C4 — personal budget — respected by three mechanisms and one measurement.** Scoped
release, reaper alarm, and a per-thread concurrency cap; plus per-gate cost recording so
the expensive parts can be judged rather than guessed at. The measurement is the part
usually missing.

**C5 — toolchain conventions — respected.** Workspace monorepo split server / client /
shared, oxlint type-aware plus oxfmt, Vitest, tagged service classes with separately
exported layers, tagged errors in one place.

**C6 — container cap — respected but binding.** See R3. The panel queues. This is the one
constraint that actively limits a requirement rather than merely shaping it.

**C7 — learning — respected, and it is the reason C1 is affordable.** Every borrowed piece
is a thin, inspectable Effect wrapper over a Cloudflare primitive rather than a framework
that hides one. Alchemy exposes Durable Object storage, alarms, hibernation and socket
attachments directly rather than behind an agent abstraction, so the primitives stay
visible — which is exactly the distinction that rules the Agents SDK out and lets Alchemy
in.

### 5. Technical Considerations

#### Key design decisions

**The event log as spine, rather than message table plus separate progress channel.** The
alternative — persist messages one way, stream progress another, trace a third — is what
both previous attempts did, and it is the direct cause of every symptom in the Problem
section. One ordered log means one mechanism serves streaming, multiplayer, resumption,
audit, and effort accounting. The cost is that append throughput becomes a load-bearing
concern that must be got right early, and that a schema mistake here is expensive to change
later. That is precisely why Phase 1 exists and why later phases are
designed now.

**No Workers Workflows.** Alternatives considered: use them as designed and give up token
streaming through steps; use them only for non-streaming sub-agents; or drop them. Chosen:
drop them. What they uniquely provide is durable execution across eviction — but a Durable
Object with SQLite and alarms already is that, so the missing piece is a checkpoint table,
not a platform primitive. Wrapping Effect inside a checkpointed step also discards Effect's
interruption semantics at every step boundary, and running two orchestration models is
worse than owning one. **Escape hatch, deliberately preserved:** Alchemy wraps Workflows
too, so a single sub-agent type that needs to sleep for weeks can use
them without disturbing the design — as long as it stays off the streaming path.

**Three Durable Object tiers, rather than one per user.** One-per-user was the prototype's
model and is why lifetimes were undefined. Splitting by natural lifetime — human,
conversation, task — gives each tier an obvious retention policy and makes "who owns this
sandbox" answerable. Cost: more cross-object RPC, and a task's events must be relayed to
the thread log rather than written directly, which is one extra hop on the streaming path.

**`Agent` is on the control path only.** It answers "which thread", "what is scheduled",
"where do I notify"; it never carries a message. Stated as a rule because the failure mode
is gradual: an agent that starts relaying messages becomes the prototype's god-object again
one convenience method at a time. Note that this makes the phrase "entry point" ambiguous
and the ambiguity is worth holding — the **network** entry point is the Worker, which
resolves identity before anything downstream sees a request; the **domain** entry point is
`Agent`. Merging them was considered and rejected: putting the log in `Agent` either drags
every socket for every conversation into one isolate, or separates the sockets from the log
and forfeits the atomic join described under R1.

**Tier names: `Agent` / `Thread` / `Task`, replacing `UserDO` / `SessionDO` / `TaskDO`.**
Two reasons, recorded because the rename is cheap now and expensive later (see the
migration risk below). First, "session" carries the wrong lifetime — in web vocabulary it
is a connection that dies with the tab, whereas this object is specifically the thing that
outlives one, and the Worker will terminate Cloudflare Access, which has sessions in the
other sense. Second, the Cloudflare Agents SDK — the closest prior art — uses `Agent` for
the addressable object and `Session` for a conversation stored _inside_ it, many per
instance. Keeping "session" for the object itself would have inverted the cardinality for
anyone reading both. `Thread` is unused by that SDK, so it is free namespace. The same
convention explains `EventLog` over `SessionLog`: that SDK names its data structures for
the mechanism (`resumable-stream`, `turn-queue`, `orphan-store`) and never for the object
that owns them, and a log named after its host is a sign the two were never separated.

**Capabilities as layers, rather than prompt-level tool restriction.** The alternative is
handing every sub-agent a broad toolset and constraining it by instruction. Under prompt
injection, instructions are negotiable and types are not. A reviewer that cannot be given
write access cannot be talked into using it. Cost: more ceremony defining and providing
layers, and the discipline holds only as far as the boundary — a capability that internally
does too much reintroduces the problem it was meant to solve.

**Secret templating at an egress proxy, rather than credentials in the registry.** The
prototype's plan put credential material in a database, which was the right instinct to
distrust. Instead the registry stores capability descriptors and secret _names_; the broker
holds values, checks the destination host, and substitutes. Wrong host yields an error
rather than a leaked token, and the database stops being sensitive at all.

**Rebuild rather than evolve.** Evolving in place would have kept a working chat loop, but
the framework's message persistence would have competed with the log for ownership of
truth, leaving two sources indefinitely. Given C7 the rebuild is also the point. Cost:
weeks before the new system does anything the old one did, which is a real morale risk and
the reason phase exit tests are written as demonstrations rather than checklists.

#### Dependencies

| Dependency                      | Role                                                                                                                                                                                              | Stability                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Effect v4 — `4.0.0-beta.102`    | The language of the system                                                                                                                                                                        | **Pre-release** — API can move                                                |
| Alchemy 2 — `2.0.0-beta.67`     | Infrastructure **and** the Cloudflare runtime: Workers, DOs, state, storage, alarms, hibernating sockets, containers, R2, KV, D1, Queues, AI Gateway, Artifacts, Worker Loader, Workflows, Access | **Pre-release**, on the `next` tag — `latest` is still the pre-Effect v1 line |
| Cloudflare Durable Objects      | State, coordination, hibernation, alarms                                                                                                                                                          | Mature                                                                        |
| Cloudflare Sandbox / Containers | Sub-agent execution                                                                                                                                                                               | GA; wrapped by Alchemy                                                        |
| Cloudflare AI Gateway           | Model routing, token and cost accounting                                                                                                                                                          | Stable; wrapped by Alchemy                                                    |
| Cloudflare Artifacts            | Versioned skill packages                                                                                                                                                                          | **Beta**                                                                      |
| Browser Rendering / Playwright  | Verification and evidence                                                                                                                                                                         | Binding stable; **Playwright-in-container unproven here**                     |
| R2, D1, Access, Queues          | Artifacts, registry, auth, buffering                                                                                                                                                              | Mature                                                                        |
| OTel collector (external)       | Span destination                                                                                                                                                                                  | Mature, but a vendor dependency — hence the log stays authoritative           |

The concentration of risk has **changed shape rather than reduced**. There are now two
pre-1.0 dependencies instead of three, and the single-maintainer one is gone — but the
remaining one is load-bearing for strictly more: Alchemy is now the single point of
dependency for both the infrastructure _and_ the runtime. Fewer things to break, more
breaks in each. On balance a better trade, because the alternative was two libraries with
overlapping Durable Object abstractions and an unresolved question about which owned the
entrypoint.

One practical hazard found immediately, worth recording because it will recur: **the
published `next` tag lags the repository's own examples.** Upstream examples show
`Cloudflare.DurableObject` and `Cloudflare.Worker` at the top level; in `beta.67` they live
under `Cloudflare.Workers`. Read the installed type definitions, not the docs.

#### Trade-offs

- **Understanding over time-to-first-demo.** C1 and C7 are paid for in weeks. This is the
  central trade and it was made deliberately.
- **One spine over specialised mechanisms.** Simpler system, but the log becomes a single
  point of design failure. Get the schema right early or migrate painfully.
- **Type-level safety over flexibility.** Layers make privilege explicit and make ad-hoc
  capability grants annoying — which is the intent, and will occasionally be irritating.
- **Consistency over stability.** Effect v4 keeps the sibling project's idiom at the cost of
  standing on pre-release APIs — and the version could not be matched exactly, so the two
  projects will drift.
- **One unified dependency over two composable ones.** Alchemy owning both infra and runtime
  removes an overlap and four hand-written wrappers; it also means a single beta package is
  load-bearing for everything below the application.
- **Correctness over cost, bounded by measurement.** Adversarial review multiplies token
  spend. Rather than guess, per-gate cost is recorded so the panel can be justified or cut
  on evidence.
- **Owned durability over platform durability.** A hand-rolled checkpoint table is less
  battle-tested than Workflows; in exchange it composes with Effect and is entirely
  legible.

### 6. Risks & Uncertainties

**Compound novelty across the whole foundation.** Four unfamiliar or unstable things at
once: Effect v4 beta, Alchemy 2 beta owning both infrastructure and runtime, Cloudflare's
young agent primitives, and a from-scratch rebuild. The prior attempt's own warning —
choosing technologies and letting them decide what gets made — applies directly, and
something like it stalled attempt two.
_Impact: High. Likelihood: High._ **Mitigation:** phases 0–2 contain no AI and exist to
falsify the foundation on a few hundred lines. Treat Phase 0 as a spike with permission to
fail; if the Effect-in-DO ergonomics are bad, that is a week spent, and the fallback is a
thinner Effect footprint at the DO boundary with plain handlers around it.

**Effect runtime versus Durable Object hibernation.** A managed runtime held on an instance
is lost on eviction, which can happen between any two messages. Anything scoped to it must
be re-acquirable.
_Impact: High. Likelihood: Medium._ **Mitigation:** the standing rule — runtime is
per-invocation and never a source of truth; all truth in SQLite. There is precedent for
being bitten by the adjacent problem, where a forked runtime failed to inherit
configuration, so this is a known failure mode rather than a hypothetical. Phase 1's exit
test is deliberately an eviction test.

**Sandbox cost and orphan containers.** Per-second billing, an agent that can spawn
agents, and a single personal budget.
_Impact: High. Likelihood: Medium._ **Mitigation:** three independent mechanisms — scoped
release, reaper alarm, per-thread concurrency cap — plus a hard spend alert outside the
system. Phase 4's exit test is explicitly adversarial about this, and the reaper is treated
as load-bearing rather than a safety net.

**Alchemy 2 is pre-release and load-bearing for everything below the application.** It owns
the Durable Object, hibernation, alarm, storage, container, R2 and inference boundaries as
well as provisioning. A breaking change lands on both tiers at once, and there is no second
implementation to fall back to.
_Impact: High. Likelihood: Medium._ **Mitigation:** pin exactly — no carets on either
Alchemy or Effect — and treat upgrades as deliberate work with the phase exit tests as the
regression suite. Keep Alchemy's idioms at the entrypoint boundary rather than letting them
spread through domain code, so `EventLog` and the capability interfaces stay portable.
Read the installed source rather than treating it as opaque; the published tag lagging its
own examples makes that mandatory, not virtuous.
_This risk replaces the first draft's `effect-cf` risk, which is struck along with the
dependency._

**Event log schema and growth.** The log is the spine; a schema mistake is expensive, and
unbounded growth degrades DO storage. Naive per-token appends would be both slow and
costly.
_Impact: High. Likelihood: Medium._ **Mitigation:** batch appends rather than writing per
token; design the schema
against the _later_ phases' needs — review findings, gate results, artifact references —
which is a stated reason for documenting the full end state now.

**~~Four platform boundaries with no Effect wrapper.~~** _Struck._ Containers, object
storage, inference and browser rendering are all provided by Alchemy 2, so this is no longer
hand-written work. What remains is composing them behind the capability interfaces — which
was always ours, and is Phase 4–6 design rather than plumbing.

**Container concurrency cap limits the review panel.** A cap of five means a four-lens panel
plus an implement sandbox saturates the account.
_Impact: Medium. Likelihood: High._ **Mitigation:** queue lenses rather than fanning out;
consider running several lenses in one sandbox as separate processes; revisit the cap in
Phase 7 with measured numbers.

**Durable Object migrations under Alchemy.** Three DO classes holding real data, on a very
new IaC integration. Renames and schema changes are the known sharp edge.
_Impact: Medium. Likelihood: Medium._ **Mitigation:** settle class names in Phase 0 before
any data exists; keep a documented manual migration path; do not assume the tool will
handle a rename. **Taken:** the wire name moved from `Sessions` to `Threads` at the end of
Phase 0, deliberately while the only data was test fixtures. A stack deployed under the old
name has an orphaned `Sessions` namespace and needs a destroy-and-redeploy rather than an
in-place update; that is the whole reason the rename happened now.

**Adversarial review may not pay for itself.** It could add cost and latency without
catching much beyond what deterministic gates already catch.
_Impact: Low. Likelihood: Medium._ **Mitigation:** accept and measure — per-lens cost and
per-lens catch rate are recorded from the start, and the panel is gated on diff risk. This
is a decision the telemetry is designed to make for us.

**Playwright traces and video inside a Cloudflare container are unproven.**
_Impact: Low. Likelihood: Medium._ **Mitigation:** spike before Phase 6 is costed; the
fallback is screenshots via the browser binding, which is a weaker but sufficient form of
evidence.

### 7. Pros & Cons Summary

| Pros                                                                                                       | Cons                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| One primitive serves streaming, multiplayer, resume, audit, and effort accounting                          | That primitive becomes a single point of design failure; the schema must be right early |
| Least privilege is a compile-time property, not a prompt instruction                                       | More ceremony per capability, and the guarantee stops at the boundary                   |
| Resource lifetimes are explicit and enforced at three tiers, with two independent leak defences            | More cross-object RPC and an extra hop on the streaming path                            |
| Effort is measurable from day one, so cost decisions rest on evidence                                      | Instrumentation must be built before anything interesting works — no early payoff       |
| Infra and application share one Effect source of truth, so no drift — no wrangler config, no generated env | One pre-release package is load-bearing for both tiers; DO migrations remain hand-held  |
| The primitives stay visible, which is the stated point of the project                                      | Weeks before parity with the prototype; real morale risk                                |
| Owned durable execution composes with Effect and is fully legible                                          | Less battle-tested than the platform's own workflow engine                              |
| Phase 0–2 falsify the foundation cheaply, before any AI exists                                             | Compound novelty remains the dominant risk regardless of ordering                       |
| A single log makes the self-improvement loop queryable — friction becomes a skill fix                      | Nothing here is validated at any scale beyond one operator                              |

### 8. Test Specifications

There are no tests in the prototype, and its own post-mortem asked for them. The four areas
below were selected deliberately: each is a deep module where a silent failure is either
expensive or invisible. Testing follows the sibling project's Vitest setup, with stack-level
integration tests where a Durable Object or container boundary is genuinely involved.
Alchemy ships a harness for exactly that — it stands a stack up, optionally in local
workerd rather than at the edge, and rides out the Cloudflare cold-start window. Note that
even the local mode resolves a Cloudflare account before planning, so stack tests need
credentials and must therefore be opt-in, leaving the default test run credential-free.

**EventLog — append and replay-from-cursor.** The spine, so these come first and must fail
loudly.

- Sequence numbers are strictly monotonic and gapless under concurrent appends from the turn
  loop and a task relay simultaneously.
- Replay from an arbitrary cursor returns exactly the missed entries, in order, with none
  duplicated and none dropped.
- A client that reconnects while an append is in flight is neither shown a gap nor sent a
  duplicate — the replay-then-subscribe join, which is the only genuinely racy part of the
  fan-out.
- Author attribution survives a hibernation cycle, exercised through schema-checked socket
  attachments rather than in-memory state.
- A malformed or unknown event kind is rejected at the boundary rather than persisted,
  because the log is authoritative and cannot be allowed to hold garbage.
- A row the current schema cannot decode costs exactly one entry and is counted, rather
  than being skipped silently or failing the whole replay.

**SandboxLease — teardown under interrupt.** The test that protects the budget.

- Interrupting the fiber mid-run runs the finaliser and destroys the container.
- A failure inside the leased scope still releases; a failure _in the finaliser_ is
  surfaced rather than swallowed.
- Eviction between acquire and release — the case no scope can catch — is caught by the
  reaper, which is asserted as an independent behaviour, not as an afterthought.
- The per-thread concurrency cap refuses a lease rather than queueing unboundedly.
- No path leaves a lease recorded as held with no live container, and none leaves a live
  container with no recorded lease. Both directions matter; only one is obvious.

**DurableStep — idempotency and resumption.**

- A completed step is not re-executed after resume; its recorded result is returned.
- Retries follow the declared schedule, and the attempt count survives eviction rather
  than resetting — a resetting counter turns a bounded retry into an unbounded one.
- A step that exhausts retries fails the task cleanly, appends a terminal event, and
  releases the lease instead of looping.
- Interleaved resumption does not double-append to the log; the log is the observable
  surface, so exactly-once _appearance_ is the property under test even where execution is
  at-least-once.

**Gate contracts and registry decoding.**

- Each gate returns structured findings a sub-agent can consume as data, and a gate failure
  is distinguishable from a gate _error_ — a crashed test runner must not read as a clean
  pass. This is the silent-failure case worth most.
- Gate composition short-circuits before expensive gates run when a cheap one fails.
- Registry rows decode through schema into valid capability descriptors, and a malformed row
  **fails closed** — a decode error must never widen egress or grant an unintended secret
  name. The negative test matters more than the positive one.
- A capability descriptor cannot name a secret the broker will not release for its allowed
  hosts; the mismatch is caught at dispatch, not at request time.
