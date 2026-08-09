# Oxian 0.21 documentation

Oxian serves Fetch-native HTTP applications through one Worker lifecycle over an
addressed in-process event fabric or outbound WebSocket. The local runtime
composes ingress and an embedded Worker for development; the same workload can
later execute in a separate process or on another machine.

## Start here

Follow the [progressive getting-started guide](getting-started.md) to build one
application from its first route through streaming, remote workers,
multi-provider operation, and production failure semantics.

Application authors can stop after Part 1. Worker operators and platform
maintainers can continue without changing the application built there.

## Concepts and operations

- [Application](application.md): routing, middleware, state, streaming, and
  edges.
- [Workers](workers.md): embedded hosts, remote clients, manifests, lifecycle,
  and protocol rules.
- [Architecture](architecture.md): component responsibilities, boundaries, and
  request path.
- [Operations](operations.md): launch, drain, observe, and release safely.
- [Runtime boundaries and adapters](runtime-adapters.md): portable exports,
  server ownership, and the current runtime support matrix.
- [Worker transport performance](performance.md): reproducible local/WSS release
  evidence and tradeoffs.

## Reference

- [API reference](api-reference.md): every public subpath, value, exported type,
  option contract, lifecycle, and failure behavior.
- [Migration to 0.21](migration-0.21.md): lifecycle and transport unification.
- [Migration to 0.20](migration-0.20.md): earlier package-boundary facts.
- [Worker protocol v1](worker-protocol-v1.md): normative transport-neutral state
  machine and frame contract.

Use `deno task verify` before publishing or releasing a package change.
