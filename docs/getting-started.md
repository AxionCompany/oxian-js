# Getting started with Oxian

This guide takes one Fetch application from a local route to workers running on
other computers. Each chapter adds complexity only after the application has a
reason to need it.

You will build **Logwash**, a small service that redacts secrets from text. It
starts as one HTTP handler, grows streaming and lifecycle behavior, then moves
unchanged behind separately operated workers.

## How this guide works

Every chapter follows the same rhythm:

1. **The pain** — the limitation in the application as it exists so far.
2. **The solution** — the smallest Oxian capability that removes it.
3. **Verify it** — an exact command and an observable result.
4. **What happened** — the relevant boundary, without unrelated internals.
5. **What this unlocks** — what the application can do now.
6. **What's next** — the next limitation that earns another concept.

The code remains Fetch-native throughout: handlers receive `Request`, return
`Response`, stream with `ReadableStream`, and stop work with `AbortSignal`.

## The path

### Part 1 — Build the application

- [Chapter 1: Your first request](getting-started/part-1-application/01-first-request.md)
  — scaffold Logwash and serve one Fetch response.
- [Chapter 2: A real HTTP API](getting-started/part-1-application/02-real-http-api.md)
  — add methods, dynamic routes, request bodies, and route checks.
- [Chapter 3: Lifecycle and middleware](getting-started/part-1-application/03-lifecycle-and-middleware.md)
  — add shared policy, worker-local state, setup, and disposal.
- [Chapter 4: Streaming and cancellation](getting-started/part-1-application/04-streaming-and-cancellation.md)
  — stream results while respecting backpressure and disconnects.

If you only author Oxian applications, Part 1 is the complete starting path. The
local runtime already exercises the workload, capacity, streaming, cancellation,
and acceptance boundaries through its in-process host. Part 2 moves that
boundary onto WSS.

### Part 2 — Move execution elsewhere

- [Chapter 5: Separate the worker](getting-started/part-2-workers/05-separate-worker.md)
  — run ingress and execution in different local processes.
- [Chapter 6: Run it on another machine](getting-started/part-2-workers/06-another-machine.md)
  — use WSS, durable credentials, and outbound-only connectivity.

Part 2 is for developers deploying workers or building a local worker client.
The Logwash application does not change when its execution moves.

### Part 3 — Operate the platform

- [Chapter 7: Workers and providers](getting-started/part-3-platform/07-workers-and-providers.md)
  — add capacity and manage compute without coupling it to transport.
- [Chapter 8: Failures and production](getting-started/part-3-platform/08-failures-and-production.md)
  — design around acceptance, no replay, draining, and secure operation.

Part 3 is for platform maintainers integrating Oxian into a control plane.
Application-owned durability and provider-owned infrastructure remain explicit
boundaries.

## Prerequisites

- Deno 2
- `curl` or another HTTP client
- a terminal that can keep `deno task` or `deno run` processes open

No database, container runtime, or cloud account is needed for Part 1.

Commands and imports pin the package version documented by this checkout. That
keeps local `deno.json` links and pre-release testing on 0.20 instead of
silently resolving an older published release.

Start with
[Chapter 1: Your first request](getting-started/part-1-application/01-first-request.md).
