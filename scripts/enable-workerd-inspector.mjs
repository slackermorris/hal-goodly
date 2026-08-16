/**
 * Teach Alchemy's local runtime to open a workerd inspector when
 * `WORKERD_INSPECTOR_ADDR` is set.
 *
 * Alchemy spawns workerd with `{ "debug-port": "127.0.0.1:0" }` and nothing
 * else. `debug-port` is workerd's internal service-binding RPC socket — it is
 * not the DevTools inspector. The inspector is a separate flag,
 * `--inspector-addr`, which `@distilled.cloud/cloudflare-runtime` already
 * understands (its control-message counter accounts for the extra
 * `listen-inspector` event) but which Alchemy never passes. Without it there
 * is no way to attach a debugger to Worker or Durable Object code.
 *
 * There is no configuration hook for this: the local runtime layer is built
 * inside `Cloudflare.providers()` from a module-memoized
 * `localRuntimeServices()` with a fixed config, so the arg has to be injected
 * at the source. Hence a patch.
 *
 * The patch is gated on the env var, so with it unset the spread is empty and
 * behaviour is byte-for-byte what it was. `npm install` replaces node_modules,
 * so this runs from `postinstall`. It is idempotent.
 */
import { readFile, writeFile } from 'node:fs/promises';

const TARGET = new URL(
  '../node_modules/@distilled.cloud/cloudflare-runtime/dist/node/Runtime.mjs',
  import.meta.url,
);

const NEEDLE = '}, { "debug-port": "127.0.0.1:0" });';

/**
 * Two injections at one call site.
 *
 * The first opens the inspector. The second holds the process right after
 * workerd is listening, which is the only moment a debugger can usefully
 * attach: the socket doesn't exist until Alchemy spawns workerd (~5s into a
 * run) and the suite is over a few seconds later. Without the pause you are
 * racing a window you can't see, and a debugger aimed at a port nothing is
 * listening on fails rather than waits.
 *
 * The notice goes out via `fs.writeSync(1)` rather than `console.log` on
 * purpose — Vitest buffers intercepted console output and flushes it when the
 * test file finishes, so a "attach now" printed through `console.log` arrives
 * long after the moment it refers to. Writing to the file descriptor bypasses
 * the interception and lands on the terminal immediately.
 */
const PATCH = `}, {
			"debug-port": "127.0.0.1:0",
			...process.env.WORKERD_INSPECTOR_ADDR ? { "inspector-addr": process.env.WORKERD_INSPECTOR_ADDR } : {}
		});`;

// The pause goes *after* `context.start(ports)` so the stack is fully wired
// while it's held — the Worker answers requests during the pause, which means
// you can also poke it by hand before letting the suite run.
const START_NEEDLE = 'yield* context.start(ports);';
const START_PATCH = `yield* context.start(ports);
		yield* Effect.promise(async () => {
			const waitMs = Number(process.env.WORKERD_DEBUG_WAIT_MS ?? 0);
			if (!process.env.WORKERD_INSPECTOR_ADDR || !(waitMs > 0)) return;
			const fs = await import("node:fs");
			fs.writeSync(1, \`\\n[debug] workerd inspector listening on \${process.env.WORKERD_INSPECTOR_ADDR}\\n\` +
				\`[debug] Attach now — run "Attach to workerd (Worker code)". Waiting \${waitMs}ms...\\n\\n\`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			fs.writeSync(1, "[debug] Resuming — running tests.\\n");
		});`;
const MARKER = 'WORKERD_INSPECTOR_ADDR';

let source;
try {
  source = await readFile(TARGET, 'utf8');
} catch {
  // The dependency isn't installed (or moved). Not worth failing an install
  // over a debugging convenience.
  console.warn('[workerd-inspector] Runtime.mjs not found — skipping patch.');
  process.exit(0);
}

if (source.includes(MARKER)) {
  process.exit(0);
}

if (!source.includes(NEEDLE) || !source.includes(START_NEEDLE)) {
  // The upstream call site changed shape. Say so loudly rather than silently
  // leaving the debugger broken — but don't fail the install.
  console.warn(
    '[workerd-inspector] Could not find the workerd serve() call site in Runtime.mjs.\n' +
      '[workerd-inspector] Alchemy has probably changed; re-check scripts/enable-workerd-inspector.mjs.',
  );
  process.exit(0);
}

await writeFile(TARGET, source.replace(NEEDLE, PATCH).replace(START_NEEDLE, START_PATCH));
console.log(
  '[workerd-inspector] Patched Runtime.mjs — WORKERD_INSPECTOR_ADDR now opens an inspector.',
);
