# Architecture

Oxian separates ingress from worker execution. HTTP is one workload adapter;
embedded libraries may dispatch their own workloads directly. Both paths use
native Web APIs and the same operation lifecycle.

```text
HTTP client -> HTTP gateway ----+
                                |
embedded application -----------+---- dispatch contract
                                     |
                    +----------------+----------------+
                    |                                 |
                    v                                 v
             WorkerHost                         Hypervisor
             in-process                         remote/process
                    |                                 |
             direct Web Streams             oxian.worker.v1 / WSS
                    |                                 |
                    v                                 v
             attached workload                 WorkerClient workload
                    +---------------+-----------------+
                                    |
                    SessionRegistry + WorkDispatcher
```

The HTTP gateway translates a `Request` into `oxian.http.v1` metadata and a byte
stream. It can dispatch to an embeddable `WorkerHost` or a WebSocket Hypervisor.
In both cases the supervisor chooses a ready session, reserves capacity, records
the acceptance boundary, and exposes the same streaming work handle. The HTTP
workload rebuilds a native `Request`, calls the application, and streams its
`Response` back.

The in-process path invokes a workload handler after acceptance commits and
passes live `ReadableStream<Uint8Array>` values directly. It does not serialize,
clone, authenticate, reconnect, or traverse a socket. The remote path maps the
same logical lifecycle onto `oxian.worker.v1` frames and explicit byte credit.
The two transports intentionally share behavior, not implementation state: a
`WorkerHost` owns its attached sessions, while a Hypervisor owns its connected
WebSocket sessions.

## Boundaries

- `app` owns the application lifecycle, middleware chain, routes, streams, and
  disposal.
- `router` imports and validates a route tree at startup, then matches only in
  memory.
- `http` defines the HTTP workload and preserves repeated headers and binary
  bodies.
- `host` owns embedded in-process workers, direct stream delivery, capacity,
  durable-start ordering, cancellation, drain, and process-local snapshots.
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

One WorkerHost owns only the workers attached to that instance. One Hypervisor
owns only the authenticated worker sessions connected to its process. Neither is
a durable global worker directory. Oxian does not provide a distributed
socket-owner directory or durable cross-replica work relay.

Deployments that need multiple gateway replicas keep that relay in their
application infrastructure and route into the owning process-local host. This
keeps transport mechanics in Oxian without moving application durability policy
into the library.

## Acceptance and settlement

Every host reserves capacity before claiming work. A remote worker expresses
that claim with `work.accepted`; the in-process host makes it directly. The
owning host persists acceptance before invoking the handler or sending
`work.start`. A remote connection loss before that persisted commit is
reschedulable. After the commit, an ambiguous failure is indeterminate and Oxian
never replays the accepted operation.

## Embedding and media channels

`createWorkerHost` can live inside another library or application without a
Hypervisor. An embedded engine attaches its capabilities as named workloads and
the owner calls `dispatch()` using the same metadata, byte streams, deadline,
and cancellation contract used by HTTP.

Oxian treats stream bytes as opaque. Text, realtime audio, and future media can
share the transport and lifecycle mechanism while keeping codecs, framing,
turn-taking, processor overrides, and modality policy in the workload layer. An
in-process worker is not a thread: CPU-heavy work still blocks its JavaScript
event loop unless the embedding application adds a worker-thread or process
boundary.

The full wire rules, including data ordering and crossed termination, are
normative in [worker protocol v1](worker-protocol-v1.md).
