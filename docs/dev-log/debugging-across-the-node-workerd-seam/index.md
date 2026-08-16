---
planted: 2026-08-16
phase: 0
---

# Debugging across the Node/workerd seam

[The previous entry](../where-durable-object-state-lives-in-local-runs/index.md)
established that a local run is workerd — the same engine that runs on the
edge, with the network and the account taken away. This entry is the
consequence nobody advertises: because the emulator is a *separate process*, a
debugger attached to the test run cannot see the application code at all.

Test code runs in Node. Debugging it is native and needs no launch config —
click the gutter icon, and the Vitest extension attaches. Worker code —
[`Api.ts`](../../../hal-server/src/Api.ts),
[`Thread.ts`](../../../hal-server/src/Thread.ts),
[`EventLog.ts`](../../../hal-server/src/EventLog.ts) — runs in workerd, a
separate process with its own V8 isolate, reached over HTTP. **A debugger
attaches to a single process, a single runtime; it cannot travel across that
seam.**

## The two processes

Captured live during a paused run — real PIDs, real ports. Alchemy spawns
*two* workerd children from the Node runner:

```
┌─ node 81653 ──────────────────────────┐
│  vitest runner                        │
│  • thread.integration.test.ts         │
│  • Effect runtime, HttpClient         │
│                                       │
│  inspector :9229  ◀── "Debug Test"    │
└───────────────┬───────────────────────┘
                │ spawns
       ┌────────┴────────┐
       ▼                 ▼
┌─ workerd 81734 ─┐  ┌─ workerd 81736 ──────────────┐
│  proxy worker   │  │  user worker                 │
│  :1337          │  │  Api.ts                      │
│  (stable addr)  │  │  Thread.ts    ← one isolate  │
│                 │  │  EventLog.ts                 │
│                 │  │  inspector :9230  ◀── Attach │
└─────────────────┘  └──────────────────────────────┘
```

The user worker's entry socket is bound as `127.0.0.1:0`, so its port is
whatever the OS hands out that run. The proxy is what gives the tests a fixed
address, and what lets Alchemy swap the worker underneath on reload without the
URL moving.

Worth noting what is *not* a separate process. `Thread` is a Durable Object, and
`threads.getByName(...).submit(...)` reads like another network hop, but the DO
class is declared on the same worker and shares its isolate. One attach covers
all three files, and stepping from the fetch handler into a DO method works.

## Why the debugger stops at the seam

What crosses is a **request**, not a stack frame:

```
test (Node isolate)                  user worker (workerd isolate)
─────────────────────                ────────────────────────────
submit(name, "first")
  HttpClient.execute
    socket.write     ──── bytes ───▶   Api.fetch starts
                     (awaits)
                     ◀─── bytes ────   returns Response
```

The Node stack *ends* at the socket write — it suspends on I/O exactly as it
would for any third-party API. On the other side, `Api.fetch` begins with a
fresh stack that has no memory of the caller. **Step Into on `submit(...)` will
not enter `Api.fetch`.** A breakpoint has to already be installed on the workerd
side before the request arrives.

## What Cloudflare offers out of the box

Cloudflare ships `@cloudflare/vitest-pool-workers`, a Vitest pool that runs the
tests *inside* workerd — one isolate, everything debuggable together, no patch
and no two-session dance. That is normally the right answer, and it does not fit
here: it is driven by `wrangler.jsonc`, and this stack is Alchemy-declared with
no wrangler config. Adopting it means a second source of truth for bindings,
which is the exact thing [`alchemy.run.ts`](../../../hal-server/alchemy.run.ts)
exists to avoid.

Alchemy's own documentation claims that
["because Workers run locally in workerd, you can attach a debugger"](https://alchemy.run/environments/local-development/#debugging).
That page names no flag and no mechanism, and the code does not back it up.

## The pieces

workerd only serves an inspector if it was **launched** with `--inspector-addr`.
It cannot be enabled after the fact — there is no equivalent of sending
`SIGUSR1` to Node. Alchemy spawns it with only `--debug-port`, an unrelated
internal RPC socket:

```typescript
{ "debug-port": "127.0.0.1:0" },
```

That is the whole of it, at
[`Runtime.ts:262`](../../../repos/alchemy/packages/cloudflare-runtime/src/core/Runtime.ts).
It was never that workerd failed to *report* an inspector — there was no
inspector to report. No flag, no socket, nothing listening, nothing to
advertise. The runtime is not missing the capability, only the argument:
[`Workerd.ts`](../../../repos/alchemy/packages/cloudflare-runtime/src/core/workerd/Workerd.ts)
already counts a `listen-inspector` control message when `inspector-addr` is
present. Nothing ever passes it.

So three pieces:

1. **A patch** on Alchemy's workerd spawn —
   [`enable-workerd-inspector.mjs`](../../../scripts/enable-workerd-inspector.mjs)
   — adding the flag, plus a pause so there is time to attach. It is idempotent
   and re-applied from `postinstall`, because `npm install` replaces
   `node_modules`.
2. **A `settings.json` entry**, `vitest.debugNodeEnv`, so the Test Explorer's
   Debug Test exposes the environment variables that switch the patch on.
3. **A `launch.json` profile** that attaches to the workerd port and tells the
   debugger where to find the source maps.

## The map was there all along

That third piece nearly became a fourth. Alchemy bundles the worker with
`minify: true` and `sourcemap: "hidden"`, and the obvious reading of that is
that the inspector only ever sees a minified `Api.js` with nothing to bind a
breakpoint to. The first fix was a `build` override on the Worker forcing an
unminified, inline-map build.

**That was solving the wrong problem.** `"hidden"` does not mean no map; it
means the map is written but not advertised. A default build leaves a 2.2 MB
`Api.js.map` on disk next to the bundle, with `sourcesContent` included and
sources — `../../../src/Api.ts` — that resolve correctly from the bundle
directory. What is missing is only the `sourceMappingURL` comment that would
point workerd at it.

So the map does not need to be rebuilt, only *found*. `cwd` and `outFiles` do
that: workerd names its scripts with a bare URL (`Api.js`), resolving that
against the bundle directory lands on the real file, and js-debug reads the
sibling `.map`. Confirmed against a default build — `Api.ts:71` mapped to
generated `120:1929`, bound, and took nine hits from live suite traffic with no
override in place. The bundle workerd executes is byte-identical to the file on
disk, so the map describes exactly what is running.

The cost is that the Worker is debugged minified. Breakpoints bind and the
editor shows TypeScript, but the scopes pane shows mangled locals —
`keepNames: true` preserves function names, not variables. The override bought
better stepping at the price of a per-Worker build block, and that price grows
with every Worker added.

## How the variables reach workerd

The chain is worth writing down because the obvious reading of it is wrong: the
environment variables are read by the **Node runner** and never reach workerd.
The patch translates them into a command-line argument at spawn time.

```
1.  click "Debug Test"
      │
2.    extension spawns the runner with debugNodeEnv:
      │   WORKERD_INSPECTOR_ADDR=127.0.0.1:9230
      │   WORKERD_DEBUG_WAIT_MS=15000
      │
3.    beforeAll(deploy(Stack)) runs *in that runner*
      │
4.    Alchemy → LocalWorkerProvider → runtime.start() → workerd.serve(config, args)
      │
5.    ◀── PATCH #1 reads process.env.WORKERD_INSPECTOR_ADDR, adds "inspector-addr"
      │
6.    spawns: workerd serve --debug-port=... --inspector-addr=127.0.0.1:9230
      │
7.    workerd binds 9230, reports "listen-inspector"
      │
8.    ◀── PATCH #2 prints the notice, awaits a timer
      │
9.    ...deploy() suspended, beforeAll unresolved, no test has run yet...
      │        ▲
      │        └── YOU ATTACH HERE — breakpoints bind
      │
10.   timer expires → tests run → breakpoints hit
```

Step 8 is not a debugger feature. The pause sits inside the deploy effect, so
`beforeAll` never resolves and Vitest has not started a test yet — ordinary
async back-pressure, used to buy a window. It is needed because workerd does not
exist for the first few seconds of a run and is gone a few seconds later, and a
debugger pointed at a port nothing is listening on fails rather than waits.

`debugNodeEnv` rather than `nodeEnv` is deliberate: it applies only when
debugging, so an ordinary Test Explorer run opens no inspector and never pauses.
The patch is gated on `WORKERD_INSPECTOR_ADDR` for the same reason — unset, on
every normal test run and every real deploy, behaviour is unchanged.

## The port that made it look broken

The inspector runs on **9230**, and the reason is recorded in `settings.json`
because it cost the most time to find. `vitest.debuggerPort` defaults to 9229,
so during Debug Test the extension's own Node debugger already owns that port.
Pointing workerd at 9229 too meant its inspector could not bind — and the attach
profile then silently succeeded against the **Node runner** instead.

**That failure does not look like a port conflict; it looks like broken source
maps.** The session connects, reports healthy, test breakpoints work, and only
the breakpoints in `Api.ts` stay hollow. Two debuggers, two runtimes, and they
cannot share a port.

## The workflow

1. **Debug Test** on a test, from the gutter or the Test Explorer.
2. Wait for `[debug] Attach now` in the terminal.
3. Run **Attach to workerd (Worker code)** from Run & Debug. Fifteen seconds.
4. Breakpoints bind, the pause expires, the test runs.

It is always two sessions, one per runtime, and both can run at once — a
breakpoint in the test to see what was sent, a breakpoint in `Api.ts` to see
what arrived.

One consequence of the chain above: a test that never causes the Worker to boot
gets no inspector and no pause. `worker returns a url` only asserts that a
string came back, so nothing spawns. That is expected, but it makes a poor
smoke test for whether the setup is working.

## What it changes

The patch is a liability and should be treated as one. It edits a beta
dependency's built output, and the only thing keeping it applied is a
`postinstall` hook; if Alchemy changes that call site the script warns rather
than failing the install, which means the failure mode is *debugging quietly
stopped working*. The honest fix is upstream, and it is small — `Workerd.ts`
already understands `inspector-addr`, so this is a flag being threaded through
`Runtime.start`, not a feature. Worth raising against
[alchemy-run/alchemy](https://github.com/alchemy-run/alchemy) rather than
carrying locally.

The `outFiles` glob is pinned to `bundles/Api`, which is a per-Worker path.
Phase 1 adds the `Agent` object and any Worker that comes with it, and each will
land in its own bundle directory. Widening the glob to `bundles/*/*.js` is the
obvious move, and worth doing at the point there is a second Worker rather than
discovering it when a breakpoint silently stops binding.

And the seam itself is a constraint to carry forward, not a temporary
annoyance. Every assertion in
[`thread.integration.test.ts`](../../../hal-server/src/thread.integration.test.ts)
observes the Worker from the outside, over HTTP, because that is the only thing
the test process can see. When a failure needs the inside view — a route that
returns 404 when it should have matched, a `seq` that advances when it should
not — reading it from the test side is inference. The setup above is what turns
that inference back into observation.
