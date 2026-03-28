---
name: oxian-js
kind: lib
summary: File-based Deno server framework handling routing, dependencies, middleware, interceptors, static serving, and SSE/streaming.
depends_on:
tags:
  - server
  - routing
  - runtime
  - sse
entrypoints:
  - src/server/server.ts
  - src/runtime/index.ts
  - src/router/index.ts
  - src/config/schema.ts
status: active
---

## Purpose

Shared HTTP/runtime framework used by clients to expose APIs through file-based routes and dependency composition.

## Read These First

- `src/server/server.ts`
- `src/runtime/index.ts`
- `src/router/index.ts`
- `src/config/schema.ts`

## Common Task Locations

- Request lifecycle and static serving: `src/server/`
- Pipeline execution and compatibility modes: `src/runtime/`
- Route matching: `src/router/`
- Core types and response helpers: `src/core/`, `src/utils/`

## Warnings

- Clients often pin older Oxian versions, so local repo changes may not affect a client until its dependency is updated.
- Base-path, CORS, and SSE behavior are framework-level concerns and can have broad client impact.
