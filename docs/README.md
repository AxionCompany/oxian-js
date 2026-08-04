# Oxian 0.20 documentation

Oxian serves Fetch-native HTTP applications through in-process or outbound
WebSocket workers. The local runtime composes ingress and a lightweight embedded
worker for development; the same application can later execute in a separate
process or on another machine.

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

## Reference

- [API reference](api-reference.md): every public subpath, value, exported type,
  option contract, lifecycle, and failure behavior.
- [Migration to 0.20](migration-0.20.md): concrete migration facts.
- [Worker protocol v1](worker-protocol-v1.md): normative WSS wire contract.

Use `deno task verify` before publishing or releasing a package change.
