---
name: oxian-js
kind: lib
summary: Fetch-native Deno HTTP applications carried to workers over outbound WSS.
depends_on:
tags:
  - deno
  - http
  - workers
  - websocket
entrypoints:
  - src/mod.ts
  - cli.ts
  - docs/README.md
status: active
---

## Purpose

Oxian 0.20 provides a file router, a Fetch-native application runtime, an HTTP
workload, a Hypervisor gateway, and outbound worker clients. It is a library;
application policy, durable worker state, provider implementation, and secrets
remain at their owning boundaries.

## Public entrypoints

- `src/mod.ts` aggregates the side-effect-free library surface.
- `cli.ts` owns process exit and signal handling for the `bin` export.
- `src/app`, `src/config`, `src/http`, `src/hypervisor`, `src/worker`, and the
  remaining explicit subpath indexes define the package surface.

## Repository map

- `src/app/`: application lifecycle, middleware, SSE, and application factories.
- `src/router/`: immutable filesystem route compilation.
- `src/http/`: HTTP metadata, body streaming, gateway, and worker workload.
- `src/hypervisor/`, `src/supervisor/`, `src/providers/`: gateway orchestration,
  process-local worker authority, and compute contracts.
- `src/worker/`, `src/transport/`, `src/protocol/`: outbound client, WebSocket
  transport, and versioned wire contract.
- `src/local/`, `src/edge/`: local composition and HTTP edge adapters.
- `docs/`: public 0.20 documentation. `v0.20-implementation-plan.md` is an
  internal implementation ledger and is not published.

Oxian deliberately owns only the sessions connected to one Hypervisor process.
Durable cross-replica routing is application infrastructure; Sandbox keeps its
PostgreSQL relay at that downstream boundary instead of exposing an unused
generic ownership abstraction from this package.

## Verify

```bash
deno task verify
```
