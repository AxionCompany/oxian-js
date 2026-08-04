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
import type { RouteMiddleware } from "jsr:@oxian/oxian-js@0.20.0-rc.6/router";

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
} from "jsr:@oxian/oxian-js@0.20.0-rc.6/app";

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
import { createServerSentEvents } from "jsr:@oxian/oxian-js@0.20.0-rc.6/app";

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
import { createCorsAdapter } from "jsr:@oxian/oxian-js@0.20.0-rc.6/edge";

const withCors = createCorsAdapter({ origins: ["https://example.com"] });
const fetch = withCors((request) => new Response(request.url));
```
