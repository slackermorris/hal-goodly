---
planted: 2026-08-11
phase: 0
---

# Reading the Agents SDK for parts

[`design.md`](../../design.md) settles it: **no Cloudflare Agents SDK**, because
everything it provides is what this project exists to build. That decision rules
out the dependency. It does not rule out the source, which is now vendored at
[`repos/cloudflare/agents-sdk`](../../../repos/cloudflare/agents-sdk) and reads
as a list of problems someone already hit.

Six of them are worth carrying into Phase 1.

## Storage: an opaque payload and almost no indexes

The session provider's table is one indexed column per thing it actually queries
by, and the message itself as text:

```sql
CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL DEFAULT '',
  parent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

Two indexes, on `parent_id` and `session_id`, and nothing else
([`providers/agent.ts`](../../../repos/cloudflare/agents-sdk/packages/agents/src/experimental/memory/session/providers/agent.ts)).
The shape of the message never reaches the schema, so an evolving event kind is
a code change rather than a migration. That is the right trade for a log whose
schema is [designed against later phases' needs](../../sdd.md) — review
findings, gate results, artifact references — none of which want a column each.

## A byte cap enforced at write time

SQLite rows cap at 2 MB; the SDK writes against 1.8 MB for headroom.

```typescript
/** Maximum serialized message size before compaction (bytes). 1.8MB with headroom below SQLite's 2MB limit. */
export const ROW_MAX_BYTES = 1_800_000;
```

[`sanitize.ts`](../../../repos/cloudflare/agents-sdk/packages/agents/src/chat/sanitize.ts)
then does a staged compaction — tool outputs first, then text parts oldest to
newest — and, crucially, **records what it did** in
`metadata.compactedToolOutputs` and `metadata.compactedTextParts`. The staged
strategy is a Phase 3 problem, arriving with the turn loop. The cap is not: a
`SessionLog` that can write a row SQLite will reject is broken from the first
append, and one line that rejects or truncates and annotates the entry is the
whole fix.

## `sendIfOpen`

A send racing a disconnect throws a specific `TypeError`. The entire guard:

```typescript
export function sendIfOpen(connection: ChatConnection, message: string): boolean {
  try {
    connection.send(message);
    return true;
  } catch (error) {
    if (isWebSocketClosedSendError(error)) return false;
    throw error;
  }
}
```

Six lines in
[`chat/connection.ts`](../../../repos/cloudflare/agents-sdk/packages/agents/src/chat/connection.ts),
matching on `"WebSocket send() after close"` and rethrowing everything else. The
file's own comment notes that three packages had hand-maintained byte-identical
copies before it was factored out, which is the usual sign that a thing is
load-bearing. The narrowness is the point — a bare `catch` here would swallow
real send failures during a fan-out.

## Multiplex by `type`, ignore unknown frames

`parseProtocolMessage` returns a discriminated union or `null`, and `null` means
both "not JSON" and "not a type I know". Callers fall through to the user's own
handler. Every unrecognised frame exits through one `default: return null`
([`parse-protocol.ts`](../../../repos/cloudflare/agents-sdk/packages/agents/src/chat/parse-protocol.ts)).
The protocol never owns the socket — which matters here, because the socket will
carry participant events, task relay frames and turn deltas before Phase 8, and
none of those exist yet.

## Tolerate corrupt rows on read

The read path parses per row and drops what it cannot use, so one bad row costs
one entry rather than the whole replay:

```typescript
private parse(json: string): SessionMessage | null {
  try {
    const msg = JSON.parse(json);
    if (typeof msg?.id === "string" && ...) return msg;
  } catch {
    /* skip */
  }
  return null;
}
```

Worth correcting the note that produced this entry: the SDK skips **silently**
— the comment is literally `/* skip */`. Skip-and-log is the better version, and
it is the version to write, because a session that quietly loses an entry during
replay is indistinguishable from a cursor bug.

This sits in tension with a rule already recorded in the
[SDD](../../sdd.md): *a malformed or unknown event kind is rejected at the
boundary rather than persisted, because the log is authoritative and cannot be
allowed to hold garbage*. The two are not in conflict once you notice they act
at opposite ends — **strict on write, forgiving on read.** The write gate is
what keeps garbage out; the read tolerance is what stops yesterday's garbage,
written before the gate was tight, from making a session unopenable. The event
schema will move during Phase 1, so both are needed at once.

## State in the attachment, never in the isolate

Cloudflare can evict a Durable Object with sockets still open and wake it on the
next frame, so anything held in isolate memory is gone between two messages on
the same connection. The SDK's own code says so from the other direction: after
hibernation its in-memory `WeakMap` is empty, but `connection.state` still reads,
because that getter is backed by the serialised WebSocket attachment.

Alchemy exposes the primitive directly —
[`hibernatable-websockets.mdx`](../../../repos/alchemy/website/src/content/docs/cloudflare/compute/hibernatable-websockets.mdx)
([published](https://alchemy.run/cloudflare/compute/hibernatable-websockets/))
walks `socket.serializeAttachment({ id })` on accept, `deserializeAttachment` on
every message, and `state.getWebSockets()` to rebuild the session map after a
wake. It also has the two-phase shape already documented in
[`Session.ts`](../../../hal-server/src/Session.ts): the `state` reference
resolves in the outer init Effect, and the calls that touch it run in the
per-instance closure. Phase 0 has that shape working for `seq`; Phase 1 needs
the same shape for author identity.

**This is the rule that makes hibernation a non-event** — and it is why the SDD
specifies that attribution survives a hibernation cycle through schema-checked
socket attachments rather than in-memory state.

## The test that proves it

Kill a client mid-exchange, reconnect, replay exactly what it missed. That is
already the Phase 1 exit criterion, and the reason it is the right one is that
it tests **the cursor, not the protocol**. A protocol test passes as long as
frames round-trip. A cursor test fails if the log's ordering, the replay
boundary, or the attribution is wrong — which are the three things that cannot
be retrofitted.

## What it changes

Three of these are one-liners that should land with the first `SessionLog`
append rather than after something breaks: the byte cap with an annotation on
the entry, `sendIfOpen` around every fan-out send, and skip-and-log on the read
path.

The other three are design constraints to hold rather than code to write. Keep
the payload opaque and the indexes to what is actually queried. Let unknown
frame types fall through instead of erroring. And put every piece of
connection-scoped truth — author identity first — in the socket attachment, on
the assumption that the isolate is discarded between any two frames.

The read-side tolerance needs writing down somewhere more permanent than this
entry, because as stated the SDD only has the write-side half of the rule.
