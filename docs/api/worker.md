# `jsr:@oxian/oxian-js@0.20.0-rc.7/worker`

The `/worker` subpath declares workload execution independently of placement.
`createWorker()` accepts one discriminated `WorkerTransport` record; there are
no transport-specific public constructors.

```ts
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "jsr:@oxian/oxian-js@0.20.0-rc.7/worker";
```

## Exports

| Export                             | Purpose                                                  |
| ---------------------------------- | -------------------------------------------------------- |
| `createWorker`                     | Create one side-effect-free Worker lifecycle.            |
| `Worker`                           | Frozen closure-capability returned by `createWorker`.    |
| `WorkerOptions`                    | In-process or WebSocket Worker declaration.              |
| `WorkerTransport`                  | Discriminated placement descriptor.                      |
| `InProcessWorkerOptions`           | Options for direct binding to a Hypervisor.              |
| `InProcessWorkerTransport`         | `{ type: "in-process", hypervisor }`.                    |
| `WebSocketWorkerOptions`           | Options for a remotely admitted Worker.                  |
| `WebSocketWorkerTransport`         | WebSocket URL, socket capability, deadline, and limits.  |
| `WorkerWebSocketLimits`            | Optional protocol queue and flow-control bounds.         |
| `WorkerWorkHandler`                | Function implementing one named workload.                |
| `WorkerWorkContext`                | Work metadata, streams, cancellation, and response hook. |
| `WorkerWorkResult`                 | Empty, bytes, stream, or metadata-plus-body result.      |
| `WorkerBody`                       | Byte array or byte stream.                               |
| `WorkerState`                      | Observable lifecycle state union.                        |
| `WorkerSnapshot`                   | Immutable current lifecycle observation.                 |
| `WorkerResult`                     | Terminal `run()` outcome.                                |
| `WorkerBeforeReadyContext`         | Bootstrap initialization context.                        |
| `WorkerHeartbeatContext`           | Point-in-time remote heartbeat context.                  |
| `WorkerReconnectContext`           | Input to reconnect-delay policy.                         |
| `WorkerReconnectDelay`             | Reconnect delay policy.                                  |
| `WorkerCredentialPersistence`      | Durable or explicitly ephemeral credential policy.       |
| `WorkerResumeCredentialPersister`  | Atomic persistence callback.                             |
| `WorkerResumeCredentialUpdate`     | Resume rotation compare-and-set payload.                 |
| `WorkerErrorCode`                  | Stable Worker failure classification.                    |
| `WorkerError`                      | Structurally typed Worker error.                         |
| `createBoundedExponentialBackoff`  | Build a capped reconnect-delay function.                 |
| `BoundedExponentialBackoffOptions` | Bounds and jitter for reconnect backoff.                 |

## One declaration, two placements

```ts
const local = createWorker({
  id: "search-worker",
  transport: { type: "in-process", hypervisor },
  workloads,
  capacity: 4,
});

const remote = createWorker({
  identity,
  credential,
  credentialPersistence: "ephemeral",
  transport: {
    type: "websocket",
    url: "wss://gateway.example/_oxian/workers/connect",
  },
  workloads,
  capacity: 4,
});
```

The in-process declaration uses `id` because direct capability possession is the
trust boundary. The WebSocket declaration uses a provisioned identity and
credential because it crosses an untrusted boundary.

```ts
type InProcessWorkerTransport = Readonly<{
  type: "in-process";
  hypervisor: Hypervisor;
}>;

type WebSocketWorkerTransport = Readonly<{
  type: "websocket";
  url: string | URL;
  allowInsecureLoopback?: boolean;
  connectTimeoutMs?: number;
  socket?: WorkerWebSocketFactory;
  limits?: WorkerWebSocketLimits;
}>;
```

`ws:` is rejected except when `allowInsecureLoopback` explicitly permits a
loopback address. Deployed Workers should use `wss:`.

## Workload contract

```ts
type WorkerWorkContext = Readonly<{
  streamId: string;
  workload: string;
  metadata: JsonObject;
  input: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  sendMetadata(metadata: JsonObject): Promise<void>;
}>;

type WorkerWorkHandler = (
  context: WorkerWorkContext,
) => WorkerWorkResult | Promise<WorkerWorkResult>;

type WorkerBody = Uint8Array | ReadableStream<Uint8Array>;

type WorkerWorkResult =
  | void
  | WorkerBody
  | Readonly<{ metadata?: JsonObject; body?: WorkerBody | null }>;
```

Metadata is sent once. Bodies use Web Streams so producers observe backpressure.
Handlers must stop cooperatively when `signal` aborts.

## Lifecycle capability

```ts
type Worker = Readonly<{
  run(): Promise<WorkerResult>;
  whenReady(): Promise<WorkerSnapshot>;
  stop(reason?: string): Promise<void>;
  snapshot(): WorkerSnapshot;
}>;
```

Construction performs no connection or binding. Call `run()`, then await
`whenReady()` before assuming the Worker is routable. Repeated `run()` calls
return the same lifecycle promise, and `stop()` is idempotent. The lifecycle
states are:

```ts
type WorkerState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "draining"
  | "drained"
  | "reconnecting"
  | "stopped";
```

`WorkerSnapshot` includes `state`, transport type, optional remote credential
state, connection identity, active streams, occupied executions, and reconnect
attempt. `WorkerResult` reports shutdown, explicit stop, re-enrollment required,
or exhausted reconnect policy.

## Initialization and heartbeats

`beforeReady(context)` runs before either placement becomes routable. For an
in-process Worker, `bootstrap` is empty; `reconnecting` is false for the first
binding and true after a maintenance drain. Its signal is scoped to that
binding. A remote Hypervisor may provide opaque bootstrap data.

`createHeartbeatMetadata(context)` supplies bounded workload-owned status for
remote heartbeats. Calls are single-flight. The frozen `WorkerHeartbeatContext`
contains identity, connection ID, capacity, sequence, inflight work, available
capacity, drain state, and a session signal.

## Credential persistence

Remote Workers choose one policy:

```ts
type WorkerCredentialPersistence =
  | Readonly<{
    credentialPersistence?: "durable";
    persistResumeCredential: WorkerResumeCredentialPersister;
  }>
  | Readonly<{
    credentialPersistence: "ephemeral";
  }>;
```

A durable `WorkerResumeCredentialUpdate` contains the rotated resume capability,
the replaced handshake ID, candidate handshake ID, and expiry. Persist them in
one compare-and-set transaction. The callback's `AbortSignal` is advisory; Oxian
never overlaps credential writes.

## Reconnect policy

`WorkerReconnectDelay` receives `WorkerReconnectContext` and returns a delay in
milliseconds or `null` to stop. `createBoundedExponentialBackoff()` accepts
`BoundedExponentialBackoffOptions` for initial delay, multiplier, cap, attempts,
and jitter. Pass `reconnectDelay: false` to disable reconnect.

## Errors

`WorkerError` is an ordinary `Error` augmented with `workerError: true`, a
`WorkerErrorCode`, and optional `cause`; no custom error class is constructed.
Codes distinguish connection, credential, handshake, initialization, protocol,
reconnect, and explicit stop failures.
