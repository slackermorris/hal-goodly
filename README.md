# hal-goodly

A personal engineering agent on Cloudflare, built from primitives in Effect.

Hal is meant to be one agent I can reach from any device, that takes a real
piece of work — "fix this bug in that repo" — and drives it to a reviewable pull
request without babysitting. Two earlier attempts stalled; this one starts from
a different foundation.

## The idea

**One append-only event log per thread is the load-bearing primitive.
Everything else is a projection of it.**

The earlier attempts had no single durable thing the whole system agreed to
write to. State was spread across workflow step results, Durable Object
storage, the WebSocket wire, and the model provider's logs, and none of those
could see each other. Every symptom traced back to that — streaming fought
durable execution, effort was unmeasurable, resumption was impossible, and
resource lifetimes were undefined.

With one ordered log, all of those become the same mechanism:

| Concern                 | Becomes                              |
| ----------------------- | ------------------------------------ |
| Streaming               | Append deltas; readers tail          |
| Multiplayer             | N sockets tailing one log            |
| Reconnection            | A cursor — replay from `seq`         |
| Async task reports back | Append `task.completed`; fan out     |
| Where effort is spent   | A `GROUP BY`                         |
| Recording changes       | Events referencing durable artifacts |

The second idea is **capability handoff**: a sub-agent is handed exactly the
abilities its job needs and has no way to express anything else — enforced by
the requirements channel, not by prompt instructions, because prompts can be
talked out of things.

The full design is in [`docs/sdd.md`](./docs/sdd.md), the argument behind it in
[`docs/event-log-thesis.md`](./docs/event-log-thesis.md), and the short form —
where we are and what is settled — in [`docs/design.md`](./docs/design.md).

## Status: Phase 1 — the spine, in progress

Phase 0 proved the foundation and is done: an Alchemy stack declaring one Worker
and one Durable Object namespace in Effect, with the binding typed by the same
declaration that provisions it. No `wrangler.jsonc`, no generated env.

Phase 1 is the log, with no AI involved. Its exit criterion:

> Two clients, one thread. Kill one mid-exchange; on reconnect it replays
> exactly what it missed, in order, with correct attribution.

What is here:

- `EventLog` — the append-only, ordered log the whole design rests on. Append
  gated on the SQLite row cap, replay from a cursor with a limit, count. It owns
  the `events` table and nothing else touches it.
- `Event` — one schema per event kind, in a discriminated union that so far has
  one member, `message`. The same schema is the SQLite row, the domain object,
  and the source of the derived JSON wire shape.
- A `Thread` Durable Object that owns one `EventLog` and exposes submit, read,
  and evict. The `Api` Worker routes `/threads/:id/{submit,read,evict}` to it.

What is deliberately **not** here yet: hibernating socket fan-out, participants,
and `head` (the rest of Phase 1), telemetry (Phase 2), any model call (Phase 3),
sandboxes (Phase 4), and everything after.

## Layout

```
hal-server/     the Worker, the Durable Objects, and the Alchemy stack
  alchemy.run.ts    the stack — infrastructure as Effect
  src/Api.ts        the entry Worker
  src/Thread.ts     the Durable Object — one per conversation
  src/EventLog.ts   the append-only log it owns
docs/           design and references
```

## Getting started

```bash
npm install
npm run check          # format, lint, typecheck, unit tests
```

### Authenticating

Anything that touches Cloudflare needs credentials — including the local-workerd
run, because Alchemy resolves an account before planning either way.

Alchemy does **not** use wrangler's login or the Cloudflare CLI. It has its own
OAuth app and its own credential store at `~/.alchemy/credentials/{profile}`, so
an existing `wrangler login` does not count. Pick one of:

**A plain Cloudflare API token — no Alchemy login, nothing stored:**

```bash
export CI=1                       # selects the env auth method without prompting
export CLOUDFLARE_ACCOUNT_ID=...  # required in env mode, validated as 32 hex chars
export CLOUDFLARE_API_TOKEN=...   # or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL
```

Export these in the shell. Alchemy is used as a library by the tests, not through
its CLI, so a `.env` file is not picked up on that path.

**Or configure a profile once:**

```bash
npx alchemy login
```

Choosing _Environment Variables_ at the prompt records `method: "env"` in the
profile, which means no OAuth grant, no stored credential, and no need for `CI=1`
afterwards. Choosing _OAuth_ is the browser flow with automatic refresh.

Note on token scope: `alchemy.run.ts` uses `Cloudflare.state()`, which keeps
Alchemy's resource state in Cloudflare by **deploying a small state-store Worker**
into the account. A narrowly-scoped token therefore needs Workers deploy
permission, not just read. Switching to Alchemy's local state store keeps state on
disk instead, at the cost of it no longer being shared across machines.

### Running it

```bash
npm run dev -w hal-server        # local workerd
npm run deploy -w hal-server     # deploy
npm run destroy -w hal-server    # tear the stack down
```

Run the stack tests:

```bash
npm run test:integration
```

That stands the stack up in local workerd and drives it over HTTP: a written
message reads back whole with its `seq`, author, and time; two authors on one
thread come back in order; text exactly on the row cap is accepted and two bytes
over returns 413; and a thread forcibly evicted keeps its log and its `seq`
across the restart.

Note that `dev: true` runs the Worker locally rather than deploying it, but
Alchemy still resolves a Cloudflare account before planning — so credentials are
required either way. The two suites are split by file name — `vitest.config.ts`
excludes `*.integration.test.ts`, `vitest.integration.config.ts` includes only
those — precisely so `npm run check` needs no credentials.

**Phase 0's "bindings typed end to end" is proven by `npm run typecheck`**,
not by a test. The Worker gets its `Threads` client from the same declaration
that provisions the namespace, so a mismatch is a compile error rather than a
runtime 500.

Or check it by hand:

```bash
npm run dev -w hal-server
curl "http://localhost:8787/health"
curl -X POST "http://localhost:8787/threads/alpha/submit" \
  -H 'content-type: application/json' \
  -d '{"text":"hello","author":"jack"}'                  # seq 1
curl "http://localhost:8787/threads/alpha/read?after=0"  # replays it
```

## Notes on the stack

Both main dependencies are on prerelease tags: `effect@4.0.0-beta.102` and
`alchemy@2.0.0-beta.67`. This is a deliberate trade — Alchemy 2 is
"infrastructure as Effects", which is the only way to get infra and application
sharing one source of truth, and it also supplies Effect-native access to the
containers, object storage, inference, and browser primitives the later phases
need.

`.npmrc` sets `min-release-age=0` for this repo only, because both packages are
published more recently than the user-level supply-chain cooldown allows.

The Cloudflare Agents SDK is **not** used, by design. See
[`AGENTS.md`](./AGENTS.md).
