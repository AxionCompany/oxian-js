# Architecture

Oxian has two stable execution roles and one placement choice:

```text
caller ── dispatch ──> Hypervisor ── selected transport ──> Worker
                            │                                  │
                            └── sessions, capacity, fencing ───┘

transport = { type: "in-process", hypervisor }
         or { type: "websocket", url, ... }
```

The Hypervisor is always the host: it admits Workers, selects a ready Worker,
reserves capacity, persists the acceptance boundary, and returns a streaming
work handle. A Worker is always the executing side: it declares named workload
functions and runs work offered by a Hypervisor. Transport is plain data on the
Worker declaration; it is not another lifecycle object developers must create or
coordinate.

`createHypervisor()` and `createWorker()` return frozen records of
closure-backed capabilities. Oxian uses no public classes or `this`-managed
state. Construction is side-effect free; explicit lifecycle functions such as
`worker.run()` and `hypervisor.shutdown()` own effects.

## One lifecycle, two transports

```text
                         +-- direct Web Streams -- Worker
                         |   (same JS isolate)
caller -> Hypervisor ----+
                         |   oxian.worker.v1
                         +-- WebSocket/WSS -------- Worker
```

The in-process transport passes live `ReadableStream<Uint8Array>` values by
reference. It does not serialize, clone, authenticate, reconnect, or traverse a
socket. It is the lightest placement when the embedding application owns both
ends. Its liveness follows the direct binding and therefore needs no synthetic
heartbeat timer.

The WebSocket transport maps the same logical lifecycle onto `oxian.worker.v1`:
registration, credential rotation, readiness, heartbeats, explicit byte credit,
drain, and reconnect. The protocol creates a process, machine, or network
isolation boundary; it does not change the workload contract.

In both cases a Worker is invisible to dispatch until initialization completes.
Both paths preserve capacity, exact targeting, durable-start ordering,
cancellation, deadlines, stream backpressure, and no replay after an ambiguous
post-acceptance failure. They also share one session registry, scheduler, and
acceptance ledger: transport selection happens only after that scheduler has
chosen and fenced a Worker.

A maintenance drain replaces only the current connection or direct binding. The
Worker preserves its identity, increments its session generation, and repeats
initialization. Explicit Worker or Hypervisor shutdown is terminal.

## HTTP is a workload adapter

The HTTP gateway translates a native `Request` into `oxian.http.v1` metadata and
a byte stream, then calls `hypervisor.dispatch()`. The HTTP workload rebuilds a
native `Request`, invokes the Fetch application, and streams its `Response`
back. Embedded libraries can skip HTTP and dispatch their own workload names
through the same `WorkInput` and `WorkHandle` contracts.

## Boundaries

- `app` owns Fetch application lifecycle, middleware, route invocation, and
  disposal.
- `router` discovers and validates a route tree, then matches requests in
  memory.
- `http` adapts native HTTP to and from the generic work contract.
- `hypervisor` owns local and remote Worker sessions, routing, acceptance,
  cancellation, drain, and process-local state.
- `worker` owns workload declarations and one lifecycle independent of
  placement.
- `work` contains the small transport-neutral dispatch contract consumed by
  embedding libraries.
- runtime adapters perform native server work. `/adapters/deno` turns a
  Hypervisor into a Fetch handler or starts a `Deno.serve` listener.
- `supervisor` contains identity, registration, fencing, and scheduling
  primitives. Identity, authority, and repository are remote admission
  concerns—not additional execution roles.
- `providers` provision or terminate compute; they do not carry work.
- `protocol` defines the remote `oxian.worker.v1` frames and ordering rules.

## Remote admission concepts

In-process binding is authorized by possession of the Hypervisor capability and
needs no credential ceremony. WebSocket admission crosses an untrusted boundary
and therefore adds three data-plane concepts:

- identity names the exact Worker attempt (`workerId`, `attemptId`, `epoch`);
- authority exchanges a one-use registration or resume credential;
- repository confirms that the declared Worker and attempt are still current.

They live together under `hypervisor.admission` and are absent from purely
in-process applications.

## Durability boundary

A Hypervisor owns only sessions connected or bound to that process. It is not a
durable global Worker directory. Multi-replica systems supply their own durable
socket-owner index or relay when dispatch can land on a different process.

Every Hypervisor reserves capacity before accepting work. It calls
`persistAcceptance` before invoking an in-process handler or sending remote
`work.start`. Before that commit, an interrupted offer may be rescheduled. After
it, an ambiguous failure is indeterminate and Oxian never silently replays the
operation.

## Streams and media

Oxian treats work bytes as opaque. Text, realtime audio, and future media can
share the same Web Streams, backpressure, cancellation, and lifecycle contract;
codecs and modality policy stay in the workload layer. In-process placement is
not a thread: CPU-heavy code still blocks its JavaScript event loop unless the
application chooses a process or thread boundary.

See [runtime boundaries and adapters](runtime-adapters.md) for portability and
[worker protocol v1](worker-protocol-v1.md) for normative remote behavior.
