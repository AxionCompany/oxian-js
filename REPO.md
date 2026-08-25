---
name: oxian-js
kind: lib
summary: Fetch-native applications carried to in-process or outbound WSS workers.
depends_on:
tags:
  - deno
  - runtime-neutral
  - adapters
  - http
  - workers
  - streams
  - websocket
entrypoints:
  - src/mod.ts
  - src/adapters/deno/index.ts
  - cli.ts
  - docs/README.md
status: active
---

## Purpose

Oxian 0.21 provides a file router, a Fetch-native application runtime, an HTTP
workload, a Hypervisor host, and Workers placed through declarative in-process
or WebSocket transports. It is a library; application policy, durable worker
state, provider implementation, and secrets remain at their owning boundaries.

## Public entrypoints

- `src/mod.ts` exposes only the side-effect-free runtime-neutral core.
- `src/adapters/deno/` owns Deno WebSocket upgrade and listener behavior.
- `cli.ts` owns process exit and signal handling for the `bin` export.
- `src/app`, `src/config`, `src/http`, `src/hypervisor`, `src/work`,
  `src/worker`, and the remaining explicit subpath indexes define the package
  surface.

## Repository map

- `src/app/`: application lifecycle, middleware, SSE, and application factories.
- `src/router/`: immutable filesystem route compilation.
- `src/http/`: HTTP metadata, body streaming, gateway, and worker workload.
- `src/work/`: the minimal transport-neutral dispatch contract used by embedding
  libraries.
- `src/hypervisor/`, `src/supervisor/`, `src/providers/`: one portable hosting
  role, process-local worker authority, and compute contracts; local process
  provisioning remains an explicit capability.
- `src/worker/`, `src/transport/`, `src/protocol/`: one Worker lifecycle,
  low-level WebSocket transport, and versioned wire contract.
- `src/local/`, `src/edge/`: local composition and HTTP edge adapters.
- `docs/`: public 0.21 documentation. Historical implementation plans are
  internal ledgers and are not published.

Oxian deliberately owns only the sessions connected to one Hypervisor process.
Durable cross-replica routing is application infrastructure; Sandbox keeps its
PostgreSQL relay at that downstream boundary instead of exposing an unused
generic ownership abstraction from this package.

## Verify

```bash
deno task verify
```
