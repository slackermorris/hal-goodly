# The session event log is the primitive the personal agent should be built on

> Copied from the Kwicherbelliaken vault (written 2026-08-01). Names in _italics_
> were vault links to notes that do not live in this repository — earlier attempts,
> source captures, and reading. External sources are listed in
> [`references.md`](./references.md).
>
> This is the argument; [`sdd.md`](./sdd.md) is the buildable form of it, and is the
> document that has been kept current. Where the two disagree, the SDD wins — most
> notably on Alchemy 2 supplying the Cloudflare runtime as well as the
> infrastructure, and on Effect v4 being settled rather than an open question.

An architecture proposal for the third attempt at _Hal Good_, superseding
_Personal agent on Cloudflare — architecture and decisions_. Written against the
requirements captured in _Second Attempt at Architecting a Personal Agent_:
multiplayer across devices, strong resource lifecycle control, an orchestration layer
that outsources to sandboxed sub-agents with adversarial review gates, heavy OTel
instrumentation of where effort goes, Effect TS, Alchemy, and async jobs that can wake
a Durable Object back up to report an outcome.

## What changed since the second attempt

_Redesign Needing More Fit For Purpose Agent Workflows_ ended on a real wall:
`step.do()` and token streaming are incompatible at the primitive level. Workflows exist
for durable checkpointed execution; streams are ephemeral. That is a correct diagnosis,
and it is the fork in the road for this design.

The second attempt also left five things you explicitly disliked: the orchestrator
pattern, credentials in the D1 registry, hand-waved DO lifecycle, no Effect, and no
ownership of the streaming layer. All five have the same root cause — **there was no
single durable thing that the whole system agreed to write to.** State was spread across
Workflow step results, DO SQLite, the WebSocket wire, and the AI Gateway's logs, and
none of them could see each other.

## The thesis

**One append-only event log per session is the load-bearing primitive. Everything else
is a projection of it.**

```
events(seq INTEGER PRIMARY KEY, ts, actor, kind, trace_id, span_id, payload JSON)
```

Look at what falls out of that one table:

| Requirement | Becomes |
|---|---|
| Streaming | Append deltas; readers tail |
| Multiplayer | N WebSockets tailing one log |
| Reconnect / resumable streams | A cursor — client sends `since=seq`, you replay |
| Async job reports back later | Task appends `task.completed`; log fan-out notifies |
| "Where is effort being spent" | `SELECT kind, SUM(payload->>'cost_usd') GROUP BY kind` |
| OTel | Every event already carries `trace_id`/`span_id` — export, don't reinvent |
| Recording the changes | Events reference R2 artifacts (diffs, screenshots, traces) |
| Lifecycle control | Compaction and retention policy on one table |

This is why streaming and durable execution stopped fighting: the sub-agent never
streams *to a client*. It streams *to the log*. Clients and durable execution are both
readers. That single inversion dissolves the problem that stalled attempt two.

The corollary matters as much as the thesis: **the log is the source of truth, not the
Effect runtime, not the WebSocket, not OTel.** OTel retention is a vendor's problem and
sockets die; the log is yours and it is in SQLite.

## Durable Object topology

Attempt two used one DO per user and collapsed everything into it, which is why
lifecycle was murky. Split it into three tiers with genuinely different lifetimes:

```
                    Cloudflare Access (Zero Trust)
                              │
              ┌───────────────┴───────────────┐
        Web client (any device)          Webhook ingress Worker
        WebSocket                       Linear / GitHub / Slack
              │                                │
              ▼                                ▼
     ┌──────────────────────────────────────────────┐
     │ UserDO — one per human, near-immortal, idle  │
     │  identity, session index, notify channels,   │
     │  long-term memory, schedule table            │
     └───────────────────┬──────────────────────────┘
                         │ owns
     ┌───────────────────▼──────────────────────────┐
     │ SessionDO — one per conversation             │
     │  ★ the event log (SQLite)                    │
     │  participants + attribution                  │
     │  WebSocket hibernation fan-out               │
     │  orchestrator turn loop                      │
     └───────────────────┬──────────────────────────┘
                         │ dispatches
     ┌───────────────────▼──────────────────────────┐
     │ TaskDO — one per delegated task, ephemeral   │
     │  durable state machine (steps table)         │
     │  owns exactly one sandbox lease              │
     │  alarm-driven resumption + TTL reaper        │
     └───────────────────┬──────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   plan sandbox    implement sandbox   verify sandbox
   (small)         (full monorepo)     (browser + Playwright)
        │                │                │
        └── Outbound Worker: egress allowlist + secret injection ──┘
                         │
              R2 (diffs, screenshots, traces)   Artifacts (skill packages)
```

`SessionDO` keyed by **session id, not user id**. This is the change that makes
multiplayer real: _Why We Built Our Own Background Agent_ is explicit that the data
model must not tie a session to one author, and every prompt must carry authorship. Your
own note wanted "clients have their own session unless invited" — that requires session
identity to be independent of user identity.

`TaskDO` is the piece attempt two was missing. It is a *durable state machine that owns
one sandbox*. One task, one sandbox, one lifetime, one owner. That is the entire
lifecycle story, and it is enforceable rather than aspirational.

## Where Effect actually earns its keep

Your earlier note worried Effect was a technology chosen before you knew what you were
building. That worry was right then and is wrong now, because this design has four
requirements that map onto Effect's *differentiating* features rather than its nice ones.

**1. `Layer` is the capability model.** This is the headline. Kenton's capability-first
argument in _Cloudflare has assembled a complete primitive stack for running AI agents safely at the edge_
— the sandbox starts powerless and capabilities are handed to it explicitly — is
literally Effect's requirements channel. A sub-agent is a value whose type states its
privileges:

```typescript
// illustrative
const reviewAgent: Effect<Findings, ReviewError, ReadOnlyDiff | SessionLog | Tracer>
const implementAgent: Effect<Patch, ImplError, GitTools | SandboxExec | SessionLog | Tracer>
```

The reviewer cannot reach `GitTools`. Not "is prompted not to" — *cannot*, because the
program does not typecheck if it tries, and nothing at the call site can provide it.
Least privilege becomes a compile error. No other option on the table gives you that.

**2. `Scope` is the resource lifecycle you asked for.** "Strong lifecycle management
control of resources" is your first requirement, and `acquireRelease` is Effect's first
answer. Sandboxes are billed per second; a leaked container is a bill.

```typescript
const sandbox = (flavour: Flavour) =>
  Effect.acquireRelease(
    createSandbox(flavour),
    (sb) => Effect.orDie(destroySandbox(sb))   // runs on success, failure, AND interrupt
  )
```

The finaliser runs on interruption, which is exactly the case that leaks in a
promise-based design. Belt and braces: pair it with a TTL reaper alarm on `TaskDO`, because
if the DO is evicted between acquire and release, no runtime-level guarantee saves you.

**3. Fibers give you "stop the agent" for free.** Interruption is structured — cancel the
fiber, finalisers run, sandbox tears down, log gets a `task.interrupted` event. Ramp calls
out mid-run cancellation as required. In a promise world you build a cooperative
cancellation protocol by hand and get it subtly wrong.

**4. `@effect/opentelemetry` means tracing is not bolted on.** `Effect.withSpan` on every
step, one layer to export. Since you want to know where effort goes, and Effect already
threads a `Tracer` through the call graph, you get the span tree for free rather than
manually propagating context across sandbox boundaries.

Secondary but real: `Schema` does quadruple duty (tool definitions, structured LLM
output, event payload encode/decode, D1 row decode); `Schedule` describes retry and
recurrence declaratively; `Effect.all` with a concurrency bound runs the reviewer panel.

**The honest friction.** Where does the runtime live? Rule: **a `ManagedRuntime` is
per-invocation and never a source of truth.** Build it at the top of `fetch`/
`webSocketMessage`/`alarm`, run, discard. Anything scoped to it must be re-acquirable
from SQLite, because eviction can happen between any two messages. You have already been
bitten by the adjacent version of this — _Effect Config_ notes that `Effect.runFork`
creates an isolated runtime that does not inherit the `ConfigProvider`.

## Drop Workers Workflows

**Recommendation: don't use them.** Reasons, in order of weight:

1. You already lost a week to Workflows vs streaming. The shape is wrong for this system.
2. Effect gives you retry, backoff, timeout, and scheduling as composable values. That is
   most of what `step.do()` buys.
3. What Workflows uniquely add is durable execution across eviction — but a DO with
   SQLite and alarms *is* durable execution across eviction. You are not missing a
   primitive, you are missing a table.
4. `step.do(() => Effect.runPromise(...))` throws away Effect's interruption semantics at
   every step boundary. Two competing orchestration models is worse than one you own.

What replaces it is genuinely small — a steps table and a check-before-run:

```typescript
// illustrative
const step = <A>(name: string, work: Effect<A, TaskError, R>) =>
  Effect.gen(function* () {
    const cached = yield* Steps.get(name)
    if (cached._tag === "Done") return cached.value as A
    const value = yield* work.pipe(
      Effect.withSpan(`step.${name}`),
      Effect.retry(Schedule.exponential("1 second").pipe(Schedule.recurs(3)))
    )
    yield* Steps.complete(name, value)
    return value
  })
```

That is your `step.do()`, it is ~40 lines, it composes with everything else, and you
understand all of it. Your own note said the disappointing part of attempt two was
suspecting you couldn't build these patterns yourself. You can, and this is the one worth
building.

**Escape hatch, named honestly:** if you find you need a task to sleep for weeks, or you
want Cloudflare's observability over step retries specifically, Workflows are still there
for that one sub-agent type. Just don't put them on the streaming path.

## Streaming, resume, and compaction

The thing that blocked you, concretely:

1. The sandbox process streams to `TaskDO` — one WebSocket or batched HTTP POSTs. It never
   talks to a browser.
2. `TaskDO` appends to the log with a monotonic `seq`. **Batch the appends** — every
   ~100 ms or N tokens. One SQLite row per token will wreck both cost and latency.
3. `TaskDO` forwards deltas to `SessionDO`, which fans out to sockets, each carrying `seq`.
4. Client persists last `seq`. On reconnect it sends `since=seq` and `SessionDO` replays
   from the log. That is resumable streams — the thing you were paying the Agents SDK for.
5. **Compaction is the lifecycle control at the data tier.** When a task finishes, collapse
   the token deltas into one final message row, keep the summary and artifact references,
   delete the deltas. Without this the log grows without bound and DO storage becomes the
   thing you regret. Nothing in the earlier notes addresses this and it will bite.

## Sub-agent execution: sandbox flavours

Take the flavour split from _The self-driving codebase Building Horizon at WorkOS_ — it
is the most directly applicable thing in your reading, because they landed on Cloudflare
Sandboxes for the same reasons you would (programmatic lifecycle, explicit egress control).

- **plan** — small, read-only checkout, no network beyond the model. Produces a task
  breakdown.
- **implement** — the full stack. Pulls the repo, edits, runs the test suite.
- **verify** — separate and smaller, with browser tooling. Crucially it runs as a *true
  client* against the implement sandbox's preview URL rather than inside it. WorkOS made
  exactly this move, and it is what lets a verification agent be adversarial: it has no
  write access to the thing it is judging.

**Browser control** wants both primitives, for different jobs:

- **Playwright inside the verify sandbox** for driving the UI, asserting, and producing
  traces and video → R2. This is your "record the changes."
- **Browser Rendering API** for cheap one-shot screenshots from a Worker, and for the
  human-in-the-loop case — `keepAlive` session, share the live URL into chat, you solve
  the login or CAPTCHA, agent continues.

Defer the speed work. Ramp's 30-minute prebuilt image snapshots and warm sandbox pools
are the right end state, but they are a phase-two optimisation, not a day-one concern for
one user.

## Quality gates as typed values, and the adversarial panel

Make a gate a *value*, not a prompt:

```typescript
// illustrative
interface Gate {
  readonly name: string
  readonly run: Effect<GateResult, GateError, SandboxExec | SessionLog | Tracer>
}
```

Then composition is ordinary Effect. Run the cheap deterministic gates concurrently,
short-circuit before spending money on the expensive ones:

```typescript
const cheap  = Effect.all([lint, typecheck, unitTests], { concurrency: "unbounded" })
const costly = Effect.all([previewScreenshots, reviewPanel], { concurrency: 2 })
```

A failing gate returns **structured findings**, not prose — that is what makes it a
feedback control rather than a log line. The implement agent consumes findings as data
and retries.

**The adversarial pattern, done properly:** the failure mode of N reviewers is that they
all find the same thing. Give each a distinct *lens* and prompt each to **refute** that
the change is correct, defaulting to "refuted" under uncertainty. Kill the PR on majority
refute and feed findings back.

You already have the lenses locally — `pr-test-analyser` and `silent-failure-analyser` are
exactly this, and your `code-reviewer` skill already runs them in parallel. The port is:
each lens becomes a reviewer agent in its own verify-flavour sandbox with read-only diff
access, and `mr-review` becomes the skill package that defines the panel.

Gate the panel on risk — diff size, paths touched — and record `effort.cost_usd` per gate
so you can *measure* whether the panel is worth what it costs. That decision should be
data, and the observability layer is what makes it data.

## Skills as Artifacts packages

Your note from Kent's Kody already has this: **skills as a package primitive hosted on
Cloudflare Artifacts.** Take it literally. A skill is a versioned repo in Artifacts
containing its prompt, its `Schema` for inputs and findings, and its gate definition. The
sandbox pulls the skill at run time.

The payoff is that skills version independently of the orchestrator, and you get Kent's
create/combine/delete/expand loop from _Your Coding Agent Needs Better Primitives_ as an
actual workflow rather than an aspiration. It also gives you the compounding loop from
Horizon: an agent hits friction, another agent reads the session log, and the fix lands in
a skill package — the system improves itself because the log is queryable.

## Credentials — fixing what you didn't like

Your instinct that credentials in the D1 registry was wrong is correct, and the fix is
smaller than you feared. Kent's Kody shows it exactly: **secret templates plus an
intercepting egress proxy.**

The agent writes `Authorization: Bearer {{secrets.GITHUB_TOKEN}}`. The Outbound Worker
intercepts every request leaving the sandbox, checks the destination against the
allowlist, and substitutes the real value only if that domain is approved for that
secret. Wrong domain gets an error, not a token.

So the registry stores **capability descriptors — never values**: which secret *names* this
agent type may reference, which hosts it may reach, which model, which sandbox flavour.
Values live in Worker Secrets, resolved only inside the Outbound Worker. D1 becomes
non-sensitive and your encryption concern evaporates.

Layer `props` on the RPC bindings for the authorisation context the sandbox cannot forge
or observe — which repo, which branch, which session. In Effect that arrives as a
requirement provided at the boundary, which means the sub-agent's type signature states
what it was authorised for.

## Observability: where effort is being spent

Treat "effort" as a first-class attribute set on every span, because the interesting
question is not "what happened" but "what did that cost me":

```
effort.tokens.in / effort.tokens.out
effort.cost_usd
effort.wall_ms
effort.sandbox_ms      ← containers bill per second; this rivals tokens
effort.retries
effort.gate_failures
```

Attributed to `(session, task, agent_type, gate, model)`. Then "where is effort going" is
one query grouped by span name, and it answers real questions: is the reviewer panel worth
it, which gate fails most, which agent type burns tokens re-reading files it already read.

Two legs, correlated:

- **OTel spans** via `@effect/opentelemetry` to a collector (Workers Logs + a Tail Worker,
  or straight to Grafana/Honeycomb). Rich, vendor-held, limited retention.
- **AI Gateway** already reports tokens and cost per request natively. Correlate by passing
  `session_id`/`task_id`/`span_id` as request metadata so the two legs join.

And underneath both, the event log — durable, local, queryable, yours, independent of any
vendor's retention window. **Do not make OTel the source of truth.** Build this in step
two, before the agent works, because effort attribution cannot be retrofitted.

## Multiplayer and devices — a correction

One misframing worth naming: **Moshi and Tailscale are not the multiplayer primitive. The
Durable Object is.** All WebSocket connections for a session route to one DO instance,
hibernation keeps idle sockets free, and state is shared because there is only one place
it lives. You get multi-device the moment you have `SessionDO` — no VPN involved.

- **Primary client**: a web app on Workers Assets, WebSocket to `SessionDO`, behind
  **Cloudflare Access**. Works on every device including your phone. Alchemy can
  provision the Access application and policies as Effect resources — that is literally
  what the `Cloudflare.Access.Policy` code in your Alchemy screenshot is doing, and it is
  how you get an agent identity distinct from your human identity.
- **Moshi** earns its place as a *third client* — a roaming-tolerant terminal into the
  implement sandbox for when you want to drive it by hand from a laptop on bad wifi. Nice,
  not load-bearing.
- **Tailscale** is only needed if something runs at home. Cloudflare Mesh / Workers VPC is
  the native equivalent if you later want a private MCP on a Mac Mini.

Worth stealing from Ramp: Slack as a client is a virality and capture surface — "notice a
bug while winding down, kick off a session, check the PR in the morning." For a personal
agent the equivalent is your phone, and it argues for push notifications being good rather
than an afterthought.

## Async resumption and the schedule affordance

- `TaskDO` sets an alarm. On wake it checks external state (is the Pages preview live? did
  CI finish?), appends events, then either advances the state machine or re-arms. Sleeping
  costs nothing. This is the poll loop attempt two wanted from Workflows.
- On completion it appends `task.completed` to `SessionDO`. If sockets are connected, fan
  out. If not, dispatch push — WhatsApp, ntfy, or email. Both is fine.
- **Recurring work** gets a schedule table on `UserDO` with a single alarm set to the next
  due entry — the per-user cron pattern from Boyney's patterns repo, already in your notes.
  `Schedule` describes the recurrence declaratively; the DO alarm is the durable executor.
  This is what enables "every morning, triage overnight nits" in the spirit of
  _Building an autonomous UI quality program_.
- **Webhook ingress** is the unlock that turns this from a chat toy into a factory, and it
  is Horizon's actual thesis: a Worker verifies signatures and normalises Linear/GitHub/
  Slack events into work items on the same queue as your chat messages. You didn't ask for
  it; it is the highest-leverage thing you are not currently planning.

## Alchemy: infra as Effect

The point of _Alchemy For Effect_ — and of Maxwell Brown's framing — is that you write
Effect to describe infra and then *use those same resource handles in your program*. So a
single `infra/` Effect program declares DO namespaces, D1, R2, sandbox flavour configs, AI
Gateway, Access policies and service tokens, Artifacts namespaces — and returns typed
handles your application depends on. No drift between `wrangler.jsonc` and `env.d.ts`,
because there is one source.

This is also the lifecycle story at the infra tier: Alchemy tracks resource state, so
teardown of a scope is real, and per-branch ephemeral stacks become cheap. That matters
here because each sandbox flavour *is* infrastructure.

Caveats worth pricing in: Alchemy is young and its Effect integration is very new (July
2026); Durable Object migrations — class renames, SQLite schema changes — are the sharp
edge in any Cloudflare IaC and will need care; and you will still want wrangler for local
dev.

## Build order — spine first, agent last

The sequencing insight: **build the log and the telemetry before the intelligence.** Both
are unretrofittable, and neither needs a model to validate.

0. **Alchemy stack that provisions almost nothing** — one Worker, one DO, described in
   Effect. This front-loads the riskiest unknown: Effect runtime inside a DO, on top of a
   young IaC tool. Learn that on 200 lines in week one, not on 5,000 lines in month three.
1. **`SessionDO` + event log + WebSocket fan-out + resume-by-cursor.** No LLM at all. Two
   browser tabs echoing each other, kill one, reconnect, watch it replay. This is the spine
   and it is the thing attempt two never had.
2. **OTel on that spine.** Prove `effort.*` attributes flow end to end while there is
   nothing to hide behind.
3. **One LLM turn** through AI Gateway, streaming into the log.
4. **`TaskDO` + sandbox under `Scope`.** The acceptance test is adversarial: kill the DO
   mid-run and assert no orphan container survives.
5. **One real code task** — clone, edit, push, PR.
6. **Gates** — typecheck, tests, preview screenshot. Structured findings.
7. **The adversarial panel.**
8. **Schedules and webhook ingress.**

Steps 0–2 are where the design gets falsified cheaply. If Effect-in-a-DO is miserable, you
find out for the price of an echo server.

## Risks and open decisions

**Three simultaneous novelties.** Effect (learning), Alchemy (young), Cloudflare agent
primitives (young). Your own warning in _Thinking About How I Tackle This_ — "I am
choosing technologies and getting them to decide what I should make" — is the single
biggest risk to this project, and something like it stalled attempt two. Steps 0–2 above
exist specifically to convert that risk into a week rather than a quarter.

**Effect runtime × DO hibernation** is genuinely unproven territory and the most likely
source of a nasty surprise. Hold the rule hard: runtime per-invocation, all truth in
SQLite.

**Sandbox cost.** Per-second billing plus an agent that can spawn sub-agents is a real
money risk. `Scope` finaliser *and* a TTL reaper alarm *and* a per-session concurrency cap.

**Event log growth.** Compaction is not optional; see above.

**Adversarial review cost.** N reviewers on every task multiplies token spend. Gate on
risk, and let `effort.cost_usd` tell you whether to keep it.

Two decisions to make before step 0:

- **Effect v3 or v4?** v4 changes service and layer ergonomics meaningfully, and OpenCode
  is already on it. Committing to v4 mid-project would be painful; committing to it now
  means fewer examples to learn from. Worth resolving deliberately rather than by default.
- **Does the orchestrator turn loop run in `SessionDO` or in a sandbox?** Running it in the
  DO is simpler and cheaper. Running it in a sandbox follows Browser Use's Pattern 2
  ("isolate the agent — it should have nothing worth stealing and nothing worth
  preserving") and gives stronger prompt-injection containment. Start in the DO; the event
  log means you can move it later without the clients noticing, which is a further argument
  for the log as the spine.
