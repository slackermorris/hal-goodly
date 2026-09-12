---
planted: 2026-09-13
phase: 1
---

# A frame is JSON, then a string

```typescript
const EventDomain = Schema.Struct({ ... });

const jsonCodec = Schema.toCodecJson(EventDomain);
```

The Encoded side is only what JSON can safely carry. The result of calling
`jsonCodec` is still an object.

```typescript
const event = { ... };

//         ┌─ Schema.Json
//         ▼
const jsonSchema = Schema.encodeUnknownSync(jsonCodec)(event);
```

But to transport it over the DO RPC boundary it needs to be stringified. The
HTTP endpoints do this automagically through the Alchemy abstraction. This is
the same derivation `HttpBody.jsonSchema` performs for an HTTP body,
`toCodecJson` then `JSON.stringify`, so replay over a socket and a page over
`/read` cannot disagree about an event's shape.

```typescript
const stringifiedSchema = Schema.fromJsonString(jsonRepresentation)
```

The `from*` convention signals that the Decoded side is JSON and the Encoded
side is a string: we encode from JSON to a string.

We can then use this schema to encode the read Event, the domain shape, into a
string.

```typescript
//         ┌─ string
//         ▼
const readyForTransport = Schema.encodeUnknownSync(stringifiedSchema)(event);
```

I also introduced a fit-for-purpose Schema, `EventFrame`, that describes the
payload the WebSocket sends over the boundary.

```typescript
const EventFrame = Schema.fromJsonString(Event);
```

## Where each step lives

`EventFrame` sits at the bottom of
[`Event.ts`](../../../hal-server/src/Event.ts), with `encodeEventFrame` and
`decodeEventFrame` as the two directions through it. `fromJsonString` is not
new to the file either. The `payload` column of `MessageEvent` has used
`fromJsonString(toCodecJson(...))` since [One schema, two
directions](../one-schema-two-directions/index.md), to get a typed payload
into a TEXT column without trusting `JSON.stringify` to improvise.

The encoding side is [`Thread.ts`](../../../hal-server/src/Thread.ts). Replay
in `fetch` reads a page from the log and sends each event through
`encodeEventFrame`; `broadcast` takes a domain event, not a string, and runs
it through the same function before fanning out. The decoding side is the
socket test client in
[`thread-websockets.integration.test.ts`](../../../hal-server/src/thread-websockets.integration.test.ts),
whose `next` maps every queued message through `decodeEventFrame`. That decode
is strict where the storage decode is forgiving: a malformed row is one
skipped entry, but a frame the client does not recognise should fail loudly.

The `HttpBody.jsonSchema` comparison is to
[`HttpBody.ts`](../../../repos/effect/packages/effect/src/unstable/http/HttpBody.ts)
in the vendored Effect repo, where `jsonSchema` is `toCodecJson` then
`JSON.stringify`. `fromJsonString` is only the second half of that. In
[`Schema.ts`](../../../repos/effect/packages/effect/src/Schema.ts) it is
`JsonString.pipe(decodeTo(schema, ...))`, so whatever the passed schema's
Encoded side already is, that is what gets stringified. For `Event` the
Encoded side is the SQLite row, and encoding an event through the frame
today produces `at` as millis and `payload` as JSON inside a string. The
`/read` route in [`Api.ts`](../../../hal-server/src/Api.ts) goes through
`HttpServerResponse.json`, which is `JSON.stringify` on the domain object, so
the same event arrives there with `at` as an ISO string and `payload` as an
object. **Replay over a socket and a page over `/read` do disagree about an
event's shape**, in exactly the way [Three shapes, and how few of them need
declaring](../three-shapes-one-declaration/index.md) described as the trap:
a boundary handed a schema that still carries the storage encoding ships the
storage encoding.

The socket test does not notice because `decodeEventFrame` reverses the same
codec, and the row round-trips. The disagreement only shows against a
consumer that reads both channels, which is what [A response that never met
the domain model](../a-response-that-never-met-the-domain-model/index.md)
found the last time two responses were compared. The test-support client in
[`HttpWorker.ts`](../../../hal-server/src/test-support/HttpWorker.ts) already
decodes `/read` through `toCodecJson`; a socket client that did the same
would fail on the first frame.

Why a string at all is the question [What survives the Durable Object RPC
boundary](../what-survives-the-durable-object-rpc-boundary/index.md) answers
for the RPC hop and [A WebSocket begins as an HTTP
request](../a-websocket-begins-as-an-http-request/index.md) sets up for the
socket: `socket.send` takes a string or bytes, so whatever the domain event
is, it has to be flattened before it leaves. The frame codec is the one place
that flattening is declared, which is also why it is the one place to put
`toCodecJson(Schema.toType(Event))` back.
