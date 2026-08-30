# Workers

A Worker is always the client that connects to a Hypervisor and executes named
workloads. `createWorker(options, callbacks)` starts immediately and returns a
frozen `Worker` capability:

```ts
type Worker = Readonly<{
  ready: Promise<WorkerSnapshot>;
  closed: Promise<WorkerResult>;
  events: ReadableStream<WorkerLifecycleEvent>;
  stop(reason?: string): Promise<void>;
  snapshot(): WorkerSnapshot;
}>;
```

There is no separate start method. Observe `ready`, `closed`, or `events`, and
use `stop()` for explicit ownership cleanup.

## In-process Worker

Use one visible declaration for both roles:

```ts
import { createHypervisor, createWorker } from "jsr:@oxian/oxian-js@0.21.1";

const transport = {
  type: "in-process",
  config: { topic: "example.echo" },
} as const;

const hypervisor = createHypervisor(
  { transports: [transport] },
  {
    async onWorkAssigned(context) {
      // Optionally persist assignment intent before work.open.
      console.log(context.operationId, context.assignment.fence.identity);
    },
    async onWorkAccepted(context) {
      // Persist the post-ACK no-replay boundary before work.start.
      await acceptedOperations.put(context.operationId, context.stageId);
    },
  },
);

const worker = createWorker(
  {
    id: "echo-worker",
    transport,
    workloads: {
      "echo.upper": async ({ input }) => {
        const bytes = await new Response(input).bytes();
        return new TextEncoder().encode(
          new TextDecoder().decode(bytes).toUpperCase(),
        );
      },
    },
  },
  {
    onStart(context) {
      console.log("starting", context.streamId);
    },
  },
);

await worker.ready;

const work = await hypervisor.dispatch({
  workload: "echo.upper",
  body: new TextEncoder().encode("hello"),
});

console.log(await new Response(work.output).text());
await work.done;

await worker.stop();
await hypervisor.shutdown();
```

When lifecycle operations are omitted for an in-process declaration, the
Hypervisor supplies process-lifetime activation, credential rotation, and
admission. This is convenient for embedded/private ownership. Durable or shared
applications should provide their own `activate`, `register`, `admit`, and
`handshake` functions even locally.

The topic is an event-fabric namespace. Frames are addressed by connection and
direction; it does not broadcast work. Local execution uses the complete v1
handshake, Ready, heartbeat, acceptance, Start, credit, terminal, drain, and
shutdown state machines. Heartbeats still carry bounded status, but an
in-process session is not expired by elapsed wall-clock time: a paused event
loop delays the Worker and Hypervisor together. Event-fabric closure, explicit
drain, and shutdown remain authoritative.

## WebSocket Worker

Only the physical transport and lifecycle integrations change:

```ts
import { createWorker } from "jsr:@oxian/oxian-js@0.21.1/worker";

const worker = createWorker(
  {
    id: "echo-worker",
    transport: {
      type: "websocket",
      config: {
        url: "wss://control.example.com/_oxian/workers/connect",
      },
    },
    workloads,
    activate: ({ workerId }) => attempts.activate(workerId),
    register: ({ identity }) => credentials.issue(identity),
    handshake: ({ rotation, bootstrap }) =>
      workerState.persistRotationAndBootstrap(rotation, bootstrap),
  },
  {
    onReady: ({ snapshot }) => console.log("ready", snapshot.connectionId),
    onWorkAccepted: ({ stageId }) => reservations.confirm(stageId),
    onStart: ({ work }) => audit.started(work.streamId),
  },
);

await worker.ready;
const result = await worker.closed;
```

A WebSocket Worker requires `activate` and `register`. The returned full
`WorkerIdentity` contains `workerId`, `attemptId`, and `epoch`; do not mint a
new attempt during reconnect. `register` may return either a one-use
registration credential or an already stored resume credential.

The `handshake` function runs after Welcome and before Ready. Persist
`context.rotation` atomically. Its `replacesHandshakeId` is the compare-and-set
predecessor; repeated calls for the same `stageId` must be idempotent. A process
restart reuses that stored handshake ID with its resume credential.

## Ready semantics

Provider compute, socket Open, Welcome, and a sent Ready frame are not proof
that the Worker is routable. The Hypervisor first runs its fenced `onReady`
gate, publishes the session, and sends `ready_ack` in order before any
`work.open`. Only after `ready_ack` does `worker.ready` resolve.

The Worker-side `onReady` callback runs after the ACK but before queued work is
processed and before the public promise resolves. It runs again after a
successful reconnect; the `ready` promise itself resolves only once.

## Workload contract

`WorkerOptions.workloads` is a record of `WorkerWorkHandler` functions. Each
receives a frozen `WorkerWorkContext`:

```ts
type WorkerWorkContext = Readonly<{
  streamId: string;
  workload: string;
  metadata: JsonObject;
  input: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  sendMetadata(metadata: JsonObject): Promise<void>;
}>;
```

A handler returns `WorkerWorkResult`: nothing, a `WorkerBody`
(`Uint8Array | ReadableStream<Uint8Array>`), or `{ metadata, body }`. Input and
output are credited streams. Respect `signal`; cancellation may cross already
queued terminal frames.

`onWorkAccepted` runs after capacity is reserved and before the Worker sends
`work.accepted`. The handler cannot run until a validated `work.start` arrives
and Worker `onStart` resolves. `onComplete` runs after the terminal result and
before process-lifetime execution capacity is released.

## Capacity and reconnect

`capacity` bounds concurrent process-lifetime executions. A lost socket does not
release a handler or output source that is still settling. This prevents a
replacement session from oversubscribing the process.

`WorkerReconnectDelay` receives a `WorkerReconnectContext`; use
`createBoundedExponentialBackoff(BoundedExponentialBackoffOptions)` for a
bounded default policy. Set `reconnectDelay: false` to stop after a lost
session. `WorkerResult` distinguishes `shutdown`, `stopped`,
`reenrollment_required`, and `reconnect_exhausted`.

`WorkerSnapshot` reports `WorkerState`, identity, credential kind, handshake,
connection, active protocol streams, occupied executions, and reconnect count.
The `WorkerLifecycleEvent` stream emits snapshots and terminal closure without
requiring polling.

## WebSocket controls

`WorkerWebSocketLimits` bounds inbound messages/bytes, pending sends, native
buffered amount, and protocol admission. A `WorkerWebSocketFactory` and
`WorkerWebSocketFactoryContext` may create an authenticated native socket:

```ts
import type { WorkerWebSocketFactory } from "jsr:@oxian/oxian-js@0.21.1/transport";

const socket: WorkerWebSocketFactory = async ({ url, protocol, signal }) => {
  const token = await identityToken(url, signal);
  return runtimeWebSocket(url, protocol, {
    headers: { authorization: `Bearer ${token}` },
  });
};
```

Pass it as `transport.config.socket`. Oxian owns the connect deadline,
subprotocol check, bounded frame adaptation, and protocol lifecycle.

## Manifest Worker runtime

The `/local` manifest runtime stores a complete identity, initial credential,
handshake ID, capacity, gateway URL, application config, and credential-store
policy. Durable mode atomically persists every `WorkerResumeCredentialUpdate`
through `WorkerResumeCredentialPersister`. `WorkerBeforeReadyContext` and
`WorkerHeartbeatContext` remain the runtime-neutral initialization/status
contexts used by those lower-level local integrations.

See [architecture](architecture.md), [operations](operations.md), and the
[normative v1 protocol](worker-protocol-v1.md).
