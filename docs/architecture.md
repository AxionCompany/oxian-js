# Architecture

Oxian separates HTTP ingress from worker execution. Each component has one
boundary and communicates with native Web APIs.

```text
HTTP client
    |
    v
HTTP gateway -> Hypervisor -> authenticated WSS session -> worker -> application
                 |                                          |
                 +-- supervisor authority and repository    +-- HTTP workload
```

The HTTP gateway translates a `Request` into `oxian.http.v1` metadata and a
credited byte stream. The Hypervisor chooses a ready session, records the
acceptance boundary, and sends the work over that session. The worker rebuilds a
native `Request`, calls the application, and streams its `Response` back.

## Boundaries

- `app` owns the application lifecycle, middleware chain, routes, streams, and
  disposal.
- `router` imports and validates a route tree at startup, then matches only in
  memory.
- `http` defines the HTTP workload and preserves repeated headers and binary
  bodies.
- `hypervisor` is a Fetch handler plus optional listener. It authenticates WSS
  workers, dispatches work, drains sessions, and reports snapshots.
- `supervisor` defines worker identity, activation, registration exchange,
  session fencing, and repository seams.
- `providers` create, inspect, and terminate compute. They do not carry work.
- `worker` owns an outbound WSS connection, credential rotation, readiness,
  heartbeats, drain, reconnect, and workload execution.
- `protocol` defines `oxian.worker.v1`, strict frame ordering, binary framing,
  and byte credit.

## Process and durability boundary

One Hypervisor owns only the authenticated worker sessions connected to its
process. Oxian does not provide a distributed socket-owner directory or durable
cross-replica work relay.

Deployments that need multiple gateway replicas keep that relay in their
application infrastructure and route into the process-local Hypervisor. In the
first dogfood integration, Sandbox retains its PostgreSQL-backed durable relay,
including acceptance and result persistence. This keeps transport mechanics in
Oxian without moving application durability policy into the library.

## Acceptance and settlement

The worker sends `work.accepted` only after reserving capacity and before
running workload code. The Hypervisor persists acceptance, then sends
`work.start`. A connection loss before that persisted commit is reschedulable.
After it is committed, the result is indeterminate and Oxian never replays the
accepted operation.

The full wire rules, including data ordering and crossed termination, are
normative in [worker protocol v1](worker-protocol-v1.md).
