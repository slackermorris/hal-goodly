---
planted: 2026-09-12
phase: 1
---

# A WebSocket begins as an HTTP request

A WebSocket connection begins as an ordinary HTTP request. It first evolves to
support a new `ws` protocol.

```typescript
const url = new URL('http:<DOMAIN>/threads/${threadName}/socket');
url.protocol = url.protocol.replace(/^http/, "ws");
```

And then it takes two extra headers. A
[Connection header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Connection)
set to Upgrade and an
[Upgrade header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Upgrade)
set to the protocol it supports.

> The HTTP **`Connection`** header controls whether the network connection
> stays open after the current transaction finishes.
>
> [MDN HTTP Connection Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Connection)

> The HTTP `Upgrade`
> [request](https://developer.mozilla.org/en-US/docs/Glossary/Request_header)
> and
> [response header](https://developer.mozilla.org/en-US/docs/Glossary/Response_header)
> can be used to upgrade an already-established client/server connection to a
> different protocol (over the same transport protocol). For example, it can be
> used by a client to upgrade a connection from HTTP/1.1 to HTTP/2, or an
> HTTP(S) connection to a WebSocket connection.
>
> [MDN Upgrade Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Upgrade)

The HTTP handler for the socket illustrates this nicely:

```typescript
 HttpRouter.route('GET', '/threads/:id/socket', (request) =>
    Effect.gen(function* () {
      if (request.headers.upgrade !== 'websocket') {
        return HttpServerResponse.text('Expected Upgrade: websocket', {
          status: 426,
        });
      }
      ...
```

These instructions ask the receiving server to switch the protocol on the TCP
connection from HTTP to Websocket. This request is the *upgrade* request.
`Cloudflare.upgrade()` is the fulfilment of the switch: the server replies with
a *Switching Protocols* response.

```typescript
fetch: Effect.gen(function* () {
  ...,
  const [response, socket] = yield* Cloudflare.upgrade();
  return response;
})
```

## Where each step lives

The protocol swap is the test client's job. The `socketUrl` helper in
[`thread-websockets.integration.test.ts`](../../../hal-server/src/thread-websockets.integration.test.ts)
rewrites the scheme, then Effect's `Socket.makeWebSocket` sends the handshake
with the two headers already set.

The 426 guard is the first thing the socket route does in
[`Api.ts`](../../../hal-server/src/Api.ts). A request that arrives without
`Upgrade: websocket` never reaches the Durable Object. One that does is
forwarded to `Thread.fetch` with the author and client identity moved from
query params onto headers.

The fulfilment is
[`Thread.fetch`](../../../hal-server/src/Thread.ts), and
[Alchemy's `upgrade`](../../../repos/alchemy/packages/alchemy/src/Cloudflare/Workers/WebSocket.ts)
is what a Switching Protocols response is made of on Cloudflare: a
`WebSocketPair`, the server half handed to `acceptWebSocket` so it hibernates,
and the client half riding on a `Response` with status 101.

This is the `upgrade` path that [`design.md`](../../design.md) still lists as
missing under "what is still to do". It sits in the working tree, uncommitted.
