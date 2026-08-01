# References

The full annotated bibliography lives in the Kwicherbelliaken vault as
**`Hal References.md`** — grouped by what each source contributed, with links
back to the local captures. Add new sources there, not here.

This file keeps only the handful of links needed while working in the repo.

## Stack documentation

- Effect — <https://effect.website>
- Alchemy — <https://alchemy.run> · repo <https://github.com/alchemy-run/alchemy>
- oxlint / oxfmt — <https://oxc.rs>
- Vitest — <https://vitest.dev>

Both Effect and Alchemy are on prerelease tags and move faster than their
published docs. **The installed type definitions are the ground truth** —
`node_modules/alchemy/lib/` and `node_modules/effect/dist/`. Upstream examples
on `main` are sometimes ahead of the tag we are pinned to; that is how the
`Cloudflare.Workers` namespace difference was found.

## Cloudflare platform

- Durable Objects — <https://developers.cloudflare.com/durable-objects/>
- Rules of Durable Objects — <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
- Sandbox SDK — <https://developers.cloudflare.com/sandbox/>
- Preview URLs — <https://developers.cloudflare.com/sandbox/concepts/preview-urls/>
- Artifacts — <https://blog.cloudflare.com/artifacts-git-for-agents-beta/>
- Docs MCP — `https://docs.mcp.cloudflare.com/mcp`

## The four systems this is modelled on

- Ramp, _Why We Built Our Own Background Agent_ — <https://builders.ramp.com/post/why-we-built-our-background-agent>
  Durable Objects per session, multiplayer as mission-critical, and the line that
  drove keying sessions by session rather than user.
- WorkOS, _Building Horizon_ — <https://workos.com/blog/project-horizon>
  Sandbox flavours under one control plane, and orchestration living outside the
  sandbox.
- WorkOS, _Autonomous UI quality_ — <https://workos.com/blog/autonomous-ui-quality-program>
  Triage as a skill; the model for scheduled and webhook-driven work.
- Kent C. Dodds, _My Agent Ships Across 6 Services Without Seeing a Secret_ —
  <https://www.youtube.com/watch?v=u2PzSPD-wVI>
  Secret templates plus an intercepting proxy — the design for `SecretBroker`.
