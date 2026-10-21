# Application model

## Routes

Oxian compiles files under `application.routesRoot` once. `index.ts` names the
directory root, `[id].ts` captures one segment, and `[...path].ts` captures the
remaining segments. A route module exports one or more uppercase HTTP methods.

```ts
// routes/projects/[id].ts
export async function GET(
  request: Request,
  context: {
    params: Readonly<Record<string, string | readonly string[]>>;
    signal: AbortSignal;
  },
): Promise<Response> {
  const id = context.params.id;
  return Response.json({ id, requestedAt: request.headers.get("date") });
}
```

Route handlers receive `(request, context)` and return a `Response` or a promise
of one. `context` contains `params`, the compiled `route`, `signal`, and
application `state`. A missing route returns 404; an unsupported method returns
405 with `Allow`; `OPTIONS` and `HEAD` are handled from the route methods.

## Middleware and state

Place `_middleware.ts` in a route directory and export a named `middleware`
function. Middleware runs from the routes root toward the selected route and
calls `next()` at most once.

```ts
// routes/_middleware.ts
import type { RouteMiddleware } from "jsr:@oxian/oxian-js@0.23.0/router";

export const middleware: RouteMiddleware = async (
  _request,
  _context,
  next,
) => {
  const response = await next();
  response.headers.set("server-timing", "app;dur=1");
  return response;
};
```

For startup state or global middleware, use an application factory. The factory
module has exactly one default export and returns the frozen application made by
`createApplication`.

```ts
// application.ts
import {
  createApplication,
  defineApplicationFactory,
} from "jsr:@oxian/oxian-js@0.23.0/app";

export default defineApplicationFactory(async ({ router, basePath, signal }) =>
  await createApplication({
    router,
    basePath,
    setup: async () => ({ startedAt: Date.now(), signal }),
    middleware: [async (_request, _context, next) => await next()],
  })
);
```

Set `application.factory` to `"./application.ts"` in `oxian.config.ts`. `setup`
runs once per worker. `dispose` runs after active responses settle. Use
`context.signal` to stop work when the client disconnects or the worker is
draining.

## Streams and SSE

Return a native streaming response for chunked output. The worker protocol
applies credit-based backpressure to its bytes.

```ts
export function GET(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first chunk\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain" } });
}
```

For server-sent events, wait for each write and close when work is done:

```ts
import { createServerSentEvents } from "jsr:@oxian/oxian-js@0.23.0/app";

export async function GET(_request: Request, context: { signal: AbortSignal }) {
  const events = createServerSentEvents({ signal: context.signal });
  void (async () => {
    await events.send({ status: "ready" }, { event: "status" });
    await events.close();
  })();
  return events.response;
}
```

## Edges

Configuration supports data-only CORS, static files, and a development proxy.
Compose code-defined adapters around a Fetch handler when policy needs a
function:

```ts
import { createCorsAdapter } from "jsr:@oxian/oxian-js@0.23.0/edge";

const withCors = createCorsAdapter({ origins: ["https://example.com"] });
const fetch = withCors((request) => new Response(request.url));
```

## WebSocket routes (unreleased)

An upgrade is decided by the same route and middleware as HTTP. Return 401 or
403 to refuse before the native handshake. To accept on either runtime adapter:

```ts
import { upgradeWebSocket } from "@oxian/oxian-js/http";

export function GET(request: Request): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket required", { status: 426 });
  }
  const { socket, response } = upgradeWebSocket(request);
  socket.onmessage = (event) => socket.send(event.data);
  return response;
}
```

Return the acceptance response unchanged; do not clone it or reconstruct a
status-101 Response. Admission may await authentication before returning it.
`socket.onopen` runs after the worker handler returns. Text and ArrayBuffer
messages retain their types; `close(code, reason)` propagates to the peer. Use
ArrayBuffer or typed arrays for binary sends; asynchronous Blob sends are not
supported by the portable socket. A selected `protocol` must have been offered
in `Sec-WebSocket-Protocol`.

Requests preserve method, URL, headers (including Origin, Cookie, Host and
protocol offers). `getClientAddress(request)` from `/http` returns the
listener's peer address, independent of forwarding headers. Standalone handler
composition must supply that address through its host integration; listener
`serve` records it automatically.

Both worker transports use the existing work stream. One open socket holds one
worker execution slot until close. Worker loss, cancellation and runtime stop
close the client with an error. No socket is resumed across worker replacement.

Deno local `start` and `dev`, and manifest workers, also host routes that call
`Deno.upgradeWebSocket(request)` directly. Native hosting uses a private
loopback connection per upgrade; portable routes in custom worker hosts need
only `createHttpWorkload`. See the [Deno adapter](api/adapters/deno.md) for
native hosting in custom deployments.

Application messages are limited to 256 KiB, pending output to 1 MiB or 64
messages, and native pending sends to 1 MiB. Overload closes with 1009.
Work-stream credit adds its separately bounded transport windows. Node enforces
the message cap while parsing WebSocket fragments. Deno's public native socket
API exposes complete messages: the cap applies on delivery, and does not bound
native reassembly allocation. Use the Node listener when a preallocation cap is
required.

`dev` currently loads routes at startup; it does not implement file hot reload.
Stop the runtime before replacing it. Runtime shutdown closes route sockets; a
process crash is observed as an abnormal socket close.

On shutdown, listeners allow peers 250 ms to acknowledge a close frame, then
force-close remaining connections. The CLI awaits application disposal before
returning. Deno listener-owned upgrades have no automatic native idle ping
timer; worker liveness still uses protocol heartbeats. Implement any
application-level route heartbeat in the app and clear it when the socket
closes.
