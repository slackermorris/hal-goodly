# hal-goodly

A personal engineering agent on Cloudflare, built from primitives in Effect.

Hal is meant to be one agent I can reach from any device, that takes a real
piece of work — "fix this bug in that repo" — and drives it to a reviewable pull
request without babysitting. Two earlier attempts stalled; this one starts from
a different foundation.

## The idea

**One append-only event log per session is the load-bearing primitive.
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

The full argument and design live in [`docs/design.md`](./docs/design.md).

## Status: Phase 0 — foundation

Phase 0 exists to falsify the foundation cheaply, before any AI is involved.
Its exit criterion:

> An echo round-trips through an Effect runtime at a Durable Object entrypoint,
> with Alchemy-declared bindings typed end to end.

What is here:

- An Alchemy stack declaring one Worker and one Durable Object namespace, in
  Effect. No `wrangler.jsonc`, no generated env — the declaration that
  provisions the namespace is the one that types the client.
- A `Sessions` Durable Object that reads and writes durable storage, so the
  runtime boundary is proven rather than assumed.
- A shared contract package, so one schema is the schema the Worker, the
  Durable Object, and the tests all agree on.

What is deliberately **not** here yet: the event log (Phase 1), telemetry
(Phase 2), any model call (Phase 3), sandboxes (Phase 4), and everything after.

## Layout

```
hal-shared/     contracts shared by server and clients
hal-server/     the Worker, the Durable Objects, and the Alchemy stack
  alchemy.run.ts    the stack — infrastructure as Effect
  src/Api.ts        the entry Worker
  src/Session.ts    the Durable Object
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

Verify the Phase 0 exit criterion:

```bash
HAL_E2E=1 npm test -w hal-server
```

That stands the stack up in local workerd and drives it over HTTP: the echo
comes back formatted by the shared function, the per-session counter advances
across requests (proving storage is durable, not per-invocation memory), and a
different session name lands on a different instance with isolated storage.

Note that `dev: true` runs the Worker locally rather than deploying it, but
Alchemy still resolves a Cloudflare account before planning — so credentials are
required either way. The test is skipped without `HAL_E2E=1` precisely so
`npm run check` needs no credentials.

**The other half of the exit criterion — "bindings typed end to end" — is
proven by `npm run typecheck`**, not by this test. The Worker gets its
`Sessions` client from the same declaration that provisions the namespace, so a
mismatch is a compile error rather than a runtime 500.

Or check it by hand:

```bash
npm run dev -w hal-server
curl "http://localhost:8787/health"
curl "http://localhost:8787/echo/alpha?text=hello%20%20world"
curl "http://localhost:8787/echo/alpha?text=again"     # seq advances
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
