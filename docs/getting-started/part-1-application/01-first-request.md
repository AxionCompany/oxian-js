# Chapter 1: Your first Logwash request

Logwash will become a small service that removes sensitive values from logs. We
will grow it one capability at a time, beginning with one HTTP request.

## The pain

A framework can make "hello world" feel larger than the problem. Before thinking
about workers, routing rules, or deployment, you need to know that you can
receive a normal web request and return a normal response.

## The solution

Oxian route handlers use the Fetch API built into Deno: a `Request` comes in and
a `Response` goes out. Start a project with the CLI, replace the generated
route, and run it locally.

You need Deno installed. Confirm that it is available:

```bash
deno --version
```

Create the Logwash project:

```bash
mkdir logwash
cd logwash
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.5/bin init
```

`init` creates this small project:

```text
logwash/
├── oxian.config.ts
└── routes/
    └── index.ts
```

The generated `oxian.config.ts` already listens on `http://127.0.0.1:8000`:

```ts
export default {
  application: {
    routesRoot: "./routes",
    basePath: "/",
  },
  gateway: {
    workerCapacity: 32,
    listener: {
      hostname: "127.0.0.1",
      port: 8000,
    },
  },
} as const;
```

Replace `routes/index.ts` with Logwash's first route:

```ts
export function GET(request: Request): Response {
  const url = new URL(request.url);

  return Response.json({
    service: "logwash",
    status: "ready",
    path: url.pathname,
  });
}
```

There are no framework-specific request or response objects here. `Request`,
`Response`, and `URL` are native web APIs.

Start the development server:

```bash
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.5/bin dev
```

Leave that terminal running. It should report:

```text
Oxian dev listening at http://127.0.0.1:8000/
```

## Verify it

In another terminal, from any directory, make the request:

```bash
curl --silent --show-error http://127.0.0.1:8000/
```

The response is:

```json
{ "service": "logwash", "status": "ready", "path": "/" }
```

Try a path that does not have a route:

```bash
curl --include http://127.0.0.1:8000/missing
```

Oxian returns `404 Not Found`.

## What happened

`dev` read `oxian.config.ts`, loaded the files under `routes/`, and opened the
configured local address. The filename `index.ts` represents `/`, and its named
`GET` export handles `GET /`.

Locally, the HTTP entrypoint and one worker run together. The request crosses
the same workload, stream, capacity, cancellation, and acceptance boundaries as
a separated worker, but direct in-process delivery avoids the loopback socket.
You do not need to configure the WSS boundary yet.

`workerCapacity` is the maximum number of concurrent HTTP executions admitted by
this local Worker. It is accounting rather than preallocated threads. A
production service should set it deliberately alongside its HTTP container
concurrency and downstream database limits.

Route files are loaded when the process starts. After changing one, stop `dev`
with `Ctrl-C` and start it again.

## What this unlocks

You now have a real HTTP service built from native Fetch primitives. Existing
knowledge and tools such as `curl`, browser `fetch`, headers, status codes, and
web streams carry directly into Oxian.

## What's next

In [Chapter 2: A real HTTP API](02-real-http-api.md), Logwash gains dynamic
profiles, multiple methods, and a JSON request body.
