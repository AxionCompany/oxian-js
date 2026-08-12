# Architecture

Oxian has two execution roles and one protocol lifecycle:

```text
application
    │ dispatch(work)
    ▼
Hypervisor ── assigns to one ready connection ──► Worker
    ▲                                             │
    └──────── metadata, bytes, terminal frames ───┘
```

A **Hypervisor** hosts Worker connections and assigns work. A **Worker** is the
client that connects and executes named workloads. Those meanings do not change
between local and remote deployments.

## Public composition

Transport topology is plain data:

```ts
import {
  createHypervisor,
  createWorker,
} from "jsr:@oxian/oxian-js@0.21.0-rc.6";

const local = {
  type: "in-process",
  config: { topic: "orders" },
} as const;

const hypervisor = createHypervisor(
  {
    transports: [local],
    admit,
    assign,
  },
  {
    onReady,
    onWorkAssigned,
    onWorkAccepted,
    onComplete,
  },
);

const worker = createWorker(
  {
    id: "orders-worker",
    transport: local,
    workloads: { "orders.execute": executeOrder },
    activate,
    register,
    handshake,
  },
  {
    onReady,
    onWorkAccepted,
    onStart,
    onComplete,
  },
);

await worker.ready;
```

The factories own resources, so they return frozen closure-backed capability
records. Identities, credentials, definitions, frames, and transport
declarations are ordinary records. There are no classes, constructors, or
data-only `create*()` helpers to memorize.

A Hypervisor has plural `transports` because it may accept several physical
connection mechanisms. A Worker has one singular `transport`. Internally, each
Hypervisor declaration becomes a live binding that owns registrations,
connections, and cleanup; “binding” is not a second public configuration term.

## One protocol kernel

Both built-in transports normalize physical input into the same bounded
`FrameConnection`:

```ts
type FrameConnection = Readonly<{
  id: string;
  protocol: string;
  incoming: ReadableStream<string | Uint8Array>;
  send(frame: string | Uint8Array): Promise<void>;
  close(reason?: string, code?: number): void;
  closed: Promise<ConnectionClose>;
}>;
```

The shared kernel then owns all of the following:

- canonical control JSON and binary data framing;
- strict `oxian.worker.v1` order validation;
- bounded inbound and outbound queues;
- credit-based stream flow control;
- cancellation and terminal-frame crossing;
- reconnect, drain, shutdown, and lease behavior; and
- the Worker and Hypervisor lifecycle transitions.

Neither physical transport invokes a workload handler directly. Local execution
pays the small framing/state-machine cost so there is one behavior to maintain.
It still avoids TCP, TLS, kernel networking, and network scheduling.

## In-process event fabric

An in-process transport record names an explicit module-realm namespace:

```ts
const transport = {
  type: "in-process",
  config: {
    topic: "copilotz.engine.01",
    maxQueuedBytes: 4 * 1024 * 1024,
    maxQueuedFrames: 1024,
  },
} as const;
```

The topic is a rendezvous address, analogous to a WebSocket URL. It is not a
work pub/sub topic.

A Hypervisor owns one active fabric per topic. Duplicate active ownership fails.
A Worker connecting to that topic receives one logical connection. Every fabric
event carries the topic, physical connection ID, direction, and unchanged
`string | Uint8Array` frame. Delivery is addressed to that exact connection;
other Workers on the same fabric cannot execute the work.

Per-connection queues preserve order and enforce byte/frame bounds. Worker stop,
Hypervisor shutdown, and failed construction remove listeners and references.
Different topics isolate independently embedded Oxian, Copilotz, or Ominipg
instances in one realm. This transport is same-realm only; a future cross-realm
transport should use an explicit `MessagePort`-like capability.

Possessing a topic is not ambient authorization. Local Workers still execute
activation, registration, admission, handshake, fencing, Ready, heartbeat,
acceptance, Start, terminal, drain, and shutdown stages.

## WebSocket transport

The host declaration is listener-oriented while the Worker declaration is
connection-oriented:

```ts
const hostTransport = {
  type: "websocket",
  config: { path: "/_oxian/workers/connect" },
} as const;

const workerTransport = {
  type: "websocket",
  config: { url: "wss://control.example.com/_oxian/workers/connect" },
} as const;
```

The Hypervisor remains listener-neutral. A runtime adapter upgrades the native
socket and adapts it to Oxian's callback socket boundary. The Worker may inject
a socket factory for provider-owned transport authentication. Production remote
connections use WSS; insecure WS is limited to explicit loopback development.

## Lifecycle ownership

Oxian owns protocol order. Applications own domain decisions and durable effects
through functions:

- `activate` establishes or resumes the complete Worker attempt identity;
- `register` returns an initial one-use or resume credential;
- `admit` verifies identity, credential, current attempt, declarations, and
  returns the session generation, rotated credential, definition, and bootstrap;
- `handshake` durably stores credential rotation and consumes bootstrap data;
- `assign` optionally chooses one fence from Oxian's ready candidates; and
- lifecycle callbacks observe or gate exact transitions.

Repository and credential-authority concepts remain important, but they are
application domain choices. Durable applications close these functions over a
database, API, key service, or transaction layer. Oxian does not require manager
objects with a prescribed method choreography.

## Assignment and no-replay boundary

The exact work sequence is:

```text
assign
  → Hypervisor onWorkAssigned
  → work.open
  → Worker onWorkAccepted
  → work.accepted
  → Hypervisor onWorkAccepted
  → Hypervisor onStart
  → work.start
  → Worker onStart
  → workload handler
  → terminal frame
  → completion callbacks
```

`onWorkAssigned` is the pre-offer durable gate: failure proves the offer was not
sent and the reservation can be released. The Worker callback runs before its
acceptance ACK. The Hypervisor `onWorkAccepted` callback runs after that ACK and
inside the canonical acceptance commit. Only after it confirms does Oxian cross
the no-replay boundary and send `work.start`.

If that post-ACK durable outcome is unknown, Oxian marks the operation
indeterminate and never blindly replays it. Work lost before acceptance remains
reschedulable. Every stage context is immutable and carries stable fence,
operation, stream, stage, and cancellation identifiers where that side of the
protocol knows them.

## Callback behavior

| Callback                   | Side       | Blocking behavior                                                                      | Failure outcome                                      |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `onActivate`, `onRegister` | Worker     | Awaited before the next bootstrap stage                                                | Worker startup fails                                 |
| `onHandshake`              | Worker     | Awaited before Ready; persist rotation idempotently                                    | Session reconnects with the correct credential state |
| `onReady`                  | Hypervisor | Awaited before publishing Ready and `ready_ack`                                        | Connection fails closed                              |
| `onReady`                  | Worker     | Awaited after `ready_ack`, before queued work is processed and public `ready` resolves | Session fails and reconnect policy applies           |
| `onHeartbeat`              | Hypervisor | Awaited before lease mutation                                                          | Connection fails closed                              |
| `onWorkAssigned`           | Hypervisor | Awaited before `work.open`                                                             | Offer is withdrawn; no Worker saw it                 |
| `onWorkAccepted`           | Worker     | Awaited before `work.accepted`                                                         | Stream/session fails closed before Start             |
| `onWorkAccepted`           | Hypervisor | Awaited after ACK, before `work.start`                                                 | Acceptance is indeterminate; never auto-replayed     |
| `onStart`                  | both       | Awaited immediately around the Start boundary                                          | Work fails closed                                    |
| `onComplete`               | both       | Awaited before local settlement/capacity release                                       | Terminal result remains authoritative                |
| `onDisconnect`             | Hypervisor | Nonblocking, exactly once per fenced connection                                        | Observer failure is ignored                          |
| `onDisconnect`             | Worker     | Awaited when the Worker capability terminates                                          | Does not change the terminal Worker result           |

Blocking callbacks must be idempotent by `stageId`. Their `AbortSignal` is
advisory; a durable transaction must still settle atomically after cancellation.
Do not await an operation that requires a later frame from the same connection
inside a connection-ordered callback.

## Frames, bytes, and streams

Control frames are canonical JSON strings. Work data is binary `Uint8Array`.
Large bodies and media are Web Streams of `Uint8Array` chunks with protocol
credit and physical backpressure. Oxian performs no base64 conversion.

Oxian does not promise “zero copy” as a semantic contract. The implementation
avoids unnecessary copies where ownership permits, but consumers always program
against typed arrays and streams. This keeps the same API useful locally, over
WSS, and for future transports.

## Runtime boundary

The package root is runtime-neutral. Filesystem loading, process spawning,
listeners, and signals live in explicit adapters/subpaths. Deno's adapter owns
`Deno.upgradeWebSocket` and optional `Deno.serve`; Node, Bun, Cloudflare, and
browser integrations can supply their native socket/listener boundary without
changing Worker lifecycle code.

A Hypervisor is process-local connection authority, not a distributed queue.
Applications own cross-replica routing, durable work records, credential stores,
and provider resources. Complete attempt and session fences prevent stale
connections or cleanup from acting on replacements.
