# Hal — agent instructions

Hal is a personal engineering agent on Cloudflare, written in Effect. Read
`docs/design.md` before making architectural changes; it is a pointer to the
source-of-truth design document and states which delivery phase we are in.

## The one rule that matters

**The thread event log is the spine.** Streaming, multiplayer, reconnection,
durable task resumption, effort accounting, and change recording are all
projections of one append-only ordered log. Do not introduce a second source of
truth for conversation state. If you find yourself adding a parallel table, a
side channel, or a cache that could disagree with the log, stop.

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
- Schema naming follows Effect's own split: domain shapes are plain nouns
  (`MessagePayload`, `Event`), codec values carry the `TypeFromEncoded`
  convention (`EventFromRow`, like `NumberFromString`), and the crossings are
  verbs (`decodeEvent`, `encodeEventForInsert`).
- Boundary shapes are built by _addition_, never by subtraction. Declare the
  smallest shape — what a caller may send — and compose upward with the fields
  the server assigns. No `Omit` of a schema type; the vendored repos never do
  it, and a shape defined by what it lacks breaks as soon as a boundary needs a
  field the domain has not got.
- The JSON encoding is never declared. `Schema.toCodecJson` derives it, and
  every HTTP entry point applies that derivation to the schema it is handed —
  so hand them a domain-encoded schema, not a storage-encoded one.

## Commands

| Command                         | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `npm run check`                 | format check, lint, typecheck, unit tests — run before every commit |
| `npm run typecheck`             | tsc across workspaces                                               |
| `npm run lint`                  | oxlint, type-aware                                                  |
| `npm run format`                | oxfmt write                                                         |
| `npm test`                      | unit tests only; stack tests are opt-in                             |
| `npm run test:integration`      | the stack tests, in local workerd — needs credentials               |
| `npm run dev -w hal-server`     | `alchemy dev`                                                       |
| `npm run deploy -w hal-server`  | `alchemy deploy`                                                    |
| `npm run destroy -w hal-server` | `alchemy destroy`                                                   |

The unit and stack suites are split by **file name**, not by an environment
variable: `vitest.config.ts` excludes `*.integration.test.ts` and
`vitest.integration.config.ts` includes only those. That is what keeps
`npm run check` credential-free.

## Cloudflare and Effect knowledge

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

When using Cloudflare primitives, inspect @repos/cloudflare/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Cloudflare patterns.

## Cost is a design constraint

Sandboxes are billed per second and this system can spawn its own sub-agents.
Any code that acquires a container must release it under every exit path,
including interruption, and must also be reachable by an independent reaper.
Never rely on a single mechanism.

## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies
