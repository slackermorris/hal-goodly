# Hal — agent instructions

Hal is a personal engineering agent on Cloudflare, written in Effect. Read
`docs/design.md` before making architectural changes; it is a pointer to the
source-of-truth design document and states which delivery phase we are in.

## The one rule that matters

**The session event log is the spine.** Streaming, multiplayer, reconnection,
durable task resumption, effort accounting, and change recording are all
projections of one append-only ordered log. Do not introduce a second source of
truth for conversation state. If you find yourself adding a parallel table, a
side channel, or a cache that could disagree with the log, stop.

Phase 0 (current) has no log yet — it exists only to prove the foundation.

## Stack

| Concern                             | Choice                                                     |
| ----------------------------------- | ---------------------------------------------------------- |
| Language                            | Effect 4 (beta) — `effect@4.0.0-beta.102`                  |
| Infrastructure + Cloudflare runtime | Alchemy 2 (beta) — `alchemy@2.0.0-beta.67`                 |
| Lint                                | oxlint, type-aware                                         |
| Format                              | oxfmt (single quotes, semicolons)                          |
| Tests                               | Vitest 4, plus `alchemy/Test/Vitest` for stack-level tests |

**There is no `wrangler.jsonc` and no generated env types.** Alchemy declares
resources in Effect and the same declaration types the client. If you reach for
wrangler config or `wrangler types`, you are fighting the design — see
`docs/design.md` on why infra and runtime share one source.

**Do not add the Cloudflare Agents SDK.** Its absence is a deliberate
constraint, not an oversight. Everything it provides — message persistence,
resumable streams, socket lifecycle, scheduling — is what we are building from
primitives, because understanding the primitives is a project goal.

## Conventions

Follow the existing Effect idiom, which matches the sibling `gen-ui-ne` project:

- Services are `Context.Service<Self, Interface>()('Name')` with the layer
  exported separately via `Layer.effect`.
- Errors are `Data.TaggedError` subclasses, collected in one `tagged-errors.ts`
  per workspace.
- Durable Objects use Alchemy's two-phase shape: the outer `Effect.gen`
  resolves shared dependencies and the state _reference_; the inner
  `Effect.gen` is the per-instance closure and the only place
  `RuntimeContext`-coloured methods (`storage.get`, `storage.put`) can run.
- Capabilities are expressed in the requirements channel. A sub-agent that must
  not write should not be _able_ to — if it can reach a write capability, the
  type is wrong, not the prompt.

## Commands

| Command                            | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `npm run check`                    | format check, lint, typecheck, unit tests — run before every commit |
| `npm run typecheck`                | tsc across workspaces                                               |
| `npm run lint`                     | oxlint, type-aware                                                  |
| `npm run format`                   | oxfmt write                                                         |
| `npm test`                         | unit tests only; stack tests are opt-in                             |
| `HAL_E2E=1 npm test -w hal-server` | the Phase 0 round-trip test, in local workerd                       |
| `npm run dev -w hal-server`        | `alchemy dev`                                                       |
| `npm run deploy -w hal-server`     | `alchemy deploy`                                                    |
| `npm run destroy -w hal-server`    | `alchemy destroy`                                                   |

## Cloudflare and Effect knowledge

Both dependencies are on prerelease tags and move quickly. **Do not answer from
memory.** Read the installed type definitions under
`node_modules/alchemy/lib/` and `node_modules/effect/dist/` — they are the
ground truth for this version, and the published docs and public examples are
sometimes ahead of the tag we are pinned to.

Notably in the version we are on, `DurableObject`, `Worker`,
`DurableObjectState` and `upgrade` live under the `Cloudflare.Workers`
namespace, even though upstream examples show them at the top level of
`alchemy/Cloudflare`.

For Cloudflare platform behaviour and limits, retrieve current docs rather than
recalling them:

- <https://developers.cloudflare.com/durable-objects/>
- <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
- MCP: `https://docs.mcp.cloudflare.com/mcp`

## Cost is a design constraint

Sandboxes are billed per second and this system can spawn its own sub-agents.
Any code that acquires a container must release it under every exit path,
including interruption, and must also be reachable by an independent reaper.
Never rely on a single mechanism.
