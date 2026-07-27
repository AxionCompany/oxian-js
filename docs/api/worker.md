# `jsr:@oxian/oxian-js@0.20.0-rc.2/worker`

[Back to the API reference](../api-reference.md)

The `/worker` subpath creates an outbound, reconnecting Oxian worker. The client
authenticates over WSS, durably rotates resume credentials, initializes
workload-owned state, sends heartbeats, executes credited work streams, and
cooperates with drain and shutdown.

```ts
import {
  createBoundedExponentialBackoff,
  createWorkerClient,
} from "jsr:@oxian/oxian-js@0.20.0-rc.2/worker";
```

Construction is side-effect free. Network ownership begins only when
`WorkerClient.run()` is called.

## Export summary

### Values

| Export                            | Purpose                                    |
| --------------------------------- | ------------------------------------------ |
| `createBoundedExponentialBackoff` | Create the default-style reconnect policy. |
| `createWorkerClient`              | Create one outbound worker lifecycle.      |

### Types

| Export                             | Purpose                                     |
| ---------------------------------- | ------------------------------------------- |
| `BoundedExponentialBackoffOptions` | Reconnect backoff tuning.                   |
| `WorkerBody`                       | Byte array or credited output stream.       |
| `WorkerWorkResult`                 | Supported workload-handler results.         |
| `WorkerWorkContext`                | One started operation's immutable context.  |
| `WorkerWorkHandler`                | Workload function contract.                 |
| `WorkerResumeCredentialUpdate`     | Atomic resume rotation to persist.          |
| `WorkerBeforeReadyContext`         | Workload initialization input.              |
| `WorkerHeartbeatContext`           | Point-in-time heartbeat metadata input.     |
| `WorkerReconnectContext`           | Reconnect policy input.                     |
| `WorkerReconnectDelay`             | Asynchronous reconnect policy.              |
| `WorkerClientState`                | Observable lifecycle states.                |
| `WorkerClientSnapshot`             | Synchronous worker status.                  |
| `WorkerClientResult`               | Terminal `run()` outcome.                   |
| `WorkerTransportOptions`           | Per-connection transport limits.            |
| `WorkerResumeCredentialPersister`  | Durable rotation callback.                  |
| `WorkerCredentialPersistence`      | Durable-default or explicit ephemeral mode. |
| `WorkerClientOptions`              | Complete worker construction contract.      |
| `WorkerClient`                     | Worker lifecycle API.                       |
| `WorkerClientErrorCode`            | Stable worker error classification.         |
| `WorkerClientError`                | Structurally classified worker error.       |

## Workload contract

### Bodies and results

```ts
type WorkerBody =
  | Uint8Array
  | ReadableStream<Uint8Array>;

type WorkerWorkResult =
  | void
  | WorkerBody
  | Readonly<{
    metadata?: JsonObject;
    body?: WorkerBody | null;
  }>;
```

A direct `Uint8Array` may be larger than one frame because its storage and
bounded slicing are explicitly owned. A `ReadableStream` must yield `Uint8Array`
chunks no larger than the v1 1 MiB payload bound. Oversized or non-byte chunks
fail that operation.

Returning `void` produces empty `{}` response metadata and no body. Returning a
body directly also produces `{}` metadata. A result object accepts exactly the
`metadata` and `body` fields; `null` body means no body. Unknown fields or an
unsupported body throw `TypeError`.

### Context and handler

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
```

The handler runs only after:

1. `work.open` reserves process-lifetime execution capacity;
2. the worker sends `work.accepted`;
3. the Hypervisor durably commits the no-replay boundary; and
4. the worker receives delivered `work.start`.

It never runs for a connection lost or cancellation completed before Start. Once
it starts, Oxian never replays it on a replacement connection.

`input` is credited as the handler pulls. Cancelling only this input stream
stops request-body delivery; it does not cancel the operation or response half.
`signal` aborts for remote cancellation, deadline, session loss, drain timeout,
shutdown, or local stop.

`sendMetadata` emits the worker's one response metadata frame and may be called
at most once. If it is not called, Oxian sends returned metadata or `{}` before
the first output byte or normal End. Returning metadata after explicitly sending
it fails the operation.

```ts
const echo: WorkerWorkHandler = async (
  { input, sendMetadata, signal },
) => {
  signal.throwIfAborted();
  await sendMetadata({ schema: "echo.response.v1" });
  return { body: input };
};
```

Thrown handler errors become `work.error` with a bounded diagnostic message.
Remote cancel/error aborts the handler and expects the reciprocal directional
terminal acknowledgement.

## Credential persistence

### Rotation update

```ts
type WorkerResumeCredentialUpdate = Readonly<{
  credential: Readonly<{
    kind: "resume";
    capability: string;
  }>;
  replacesHandshakeId: string;
  handshakeId: string;
  resumeExpiresAtMs: number;
}>;

type WorkerResumeCredentialPersister = (
  update: WorkerResumeCredentialUpdate,
  context: Readonly<{ signal: AbortSignal }>,
) => void | Promise<void>;
```

Persist all four fields atomically. The resume capability and its new
`handshakeId` are one durable value. `replacesHandshakeId` is the compare-and-
set predecessor: a write is valid only when storage contains that ID or already
contains the candidate ID.

The persister must be idempotent for an identical update and resolve only after
durable commit. Oxian adopts the new credential only after that resolution. If
the persistence promise explicitly rejects before commit, the previous
credential and handshake ID remain current and the exact exchange can be
retried.

The signal is advisory. A timeout, disconnect, or stop cannot cancel an
arbitrary persistence promise. Oxian does not begin another persistence call or
connection while the prior write remains unresolved. A late successful
settlement is adopted before reconnect.

### Persistence mode

```ts
type WorkerCredentialPersistence =
  | Readonly<{
    credentialPersistence?: "durable";
    persistResumeCredential: WorkerResumeCredentialPersister;
  }>
  | Readonly<{
    credentialPersistence: "ephemeral";
    persistResumeCredential?: never;
  }>;
```

Durable persistence is the default mode, so omitting `credentialPersistence`
still requires `persistResumeCredential`. Use `"ephemeral"` only for a
process-lifetime worker whose resume state may be lost at restart. Combining an
ephemeral mode with a persister throws `TypeError`.

An initial resume credential must include `resumeExpiresAtMs`, and callers
should also supply the `handshakeId` stored with that credential. When the ID is
omitted, the client generates a fresh one. The client checks expiry locally
before each connection.

## Initialization and heartbeat contexts

```ts
type WorkerBeforeReadyContext = Readonly<{
  bootstrap: JsonObject;
  connectionId: string;
  signal: AbortSignal;
  reconnecting: boolean;
}>;
```

`beforeReady` applies the opaque bootstrap from `welcome` after credential
persistence and before the client sends `ready`. Its returned JSON becomes Ready
metadata; `void` becomes `{}`. The hook is bounded by `readyTimeoutMs`, invoked
sequentially across reconnects, and must be idempotent. Failure rejects
readiness for this session and reconnects using the newly persisted resume
credential.

```ts
type WorkerHeartbeatContext = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  capacity: number;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  draining: boolean;
  signal: AbortSignal;
}>;
```

The context and nested identity are frozen. `inflight` is the greater of current
protocol streams and still-occupied process executions. `availableCapacity`
becomes zero during drain.

`createHeartbeatMetadata` returns opaque JSON or `void`. Calls are single-flight
across ticks and connections. Invalid JSON, an oversized control frame, or a
thrown callback fails the current session. A hung callback does not block remote
Shutdown or `stop()`, but the client will not invoke another copy concurrently.

## Reconnect policies

### Types

```ts
type WorkerReconnectContext = Readonly<{
  attempt: number;
  error: unknown;
  credentialKind: WorkerCredential["kind"];
  resumeExpiresAtMs?: number;
}>;

type WorkerReconnectDelay = (
  context: WorkerReconnectContext,
) => number | null | Promise<number | null>;
```

Attempts begin at one and count consecutive delayed reconnects. A successful
Ready resets the count. Return a non-negative integer delay in milliseconds or
`null` to stop. The value cannot exceed `maxReconnectDelayMs`. Oxian shortens a
delay when necessary so it does not sleep past the current resume expiry.

The callback is single-flight. `stop()` does not wait for a callback that
ignores its advisory signal.

### `createBoundedExponentialBackoff`

```ts
type BoundedExponentialBackoffOptions = Readonly<{
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitter?: number;
  maxAttempts?: number;
  random?: () => number;
}>;

function createBoundedExponentialBackoff(
  options?: BoundedExponentialBackoffOptions,
): WorkerReconnectDelay;
```

Defaults are:

| Option           | Default       |
| ---------------- | ------------- |
| `initialDelayMs` | 250 ms        |
| `maxDelayMs`     | 30 seconds    |
| `multiplier`     | 2             |
| `jitter`         | 0.2           |
| `maxAttempts`    | unlimited     |
| `random`         | `Math.random` |

For attempt `n`, the base delay is
`min(maxDelayMs, initialDelayMs * multiplier ** (n - 1))`. Jitter samples a
factor from `1 - jitter` through `1 + jitter`; the rounded result is clamped
from zero through `maxDelayMs`. Returning `null` begins after `maxAttempts`.

All numeric options must be finite and within their documented range:
non-negative initial delay, maximum at least the initial delay, multiplier at
least one, jitter from zero through one, and a positive safe-integer attempt
bound. `random()` must return a finite number from zero through one. Invalid
construction or invocation values throw `TypeError`.

## Transport options

```ts
type WorkerTransportOptions = Readonly<{
  maxInboundMessages?: number;
  maxInboundBytes?: number;
  maxPendingSendMessages?: number;
  maxPendingSendBytes?: number;
  maxBufferedAmountBytes?: number;
  bufferedAmountLowWaterBytes?: number;
  bufferedAmountPollMs?: number;
  protocol?: Omit<ProtocolOrderValidatorOptions, "role">;
}>;
```

These options are forwarded to each newly created `WebSocketTransport`. They
bound one connection's receive queue, pending send queue, native socket
buffering, polling interval, and protocol admission. The worker role is fixed
and cannot be overridden. See the [transport API](transport.md) for defaults and
validation.

## `WorkerClientOptions`

`WorkerClientOptions` combines the following base fields with exactly one
`WorkerCredentialPersistence` branch:

```ts
type WorkerClientOptions =
  & Readonly<{
    url: string | URL;
    identity: WorkerIdentity;
    credential: WorkerCredential;
    handshakeId?: string;
    resumeExpiresAtMs?: number;
    workloads: Readonly<Record<string, WorkerWorkHandler>>;
    capacity?: number;
    signal?: AbortSignal;
    allowInsecureLoopback?: boolean;
    connectTimeoutMs?: number;
    createWebSocket?: WorkerWebSocketFactory;
    handshakeTimeoutMs?: number;
    readyTimeoutMs?: number;
    resumeExpirySkewMs?: number;
    inputBufferBytes?: number;
    reconnectDelay?: WorkerReconnectDelay | false;
    maxReconnectDelayMs?: number;
    transport?: WorkerTransportOptions;
    createHandshakeId?: () => string;
    now?: () => number;
    beforeReady?: (
      context: WorkerBeforeReadyContext,
    ) => JsonObject | void | Promise<JsonObject | void>;
    createHeartbeatMetadata?: (
      context: WorkerHeartbeatContext,
    ) => JsonObject | void | Promise<JsonObject | void>;
    onStateChange?: (
      snapshot: WorkerClientSnapshot,
    ) => void | Promise<void>;
    onReenrollmentRequired?: (
      error: unknown,
    ) => void | Promise<void>;
  }>
  & WorkerCredentialPersistence;
```

### Required fields

- `url` is the Hypervisor worker endpoint. Production requires `wss:`. `ws:` is
  accepted only for explicit loopback use with `allowInsecureLoopback: true`.
- `identity` is the complete provisioned worker, attempt, and epoch fence. Do
  not generate a new attempt ID on every process restart.
- `credential` is the initial registration or stored resume capability.
- `workloads` must contain at least one valid, uniquely named handler.
- durable mode requires `persistResumeCredential`.

### Defaults

| Option                  | Default                                |
| ----------------------- | -------------------------------------- |
| `handshakeId`           | `crypto.randomUUID()`                  |
| `capacity`              | 1                                      |
| `allowInsecureLoopback` | `false`                                |
| `connectTimeoutMs`      | transport default, 15 seconds          |
| `handshakeTimeoutMs`    | 15 seconds                             |
| `readyTimeoutMs`        | 5 minutes                              |
| `resumeExpirySkewMs`    | 30 seconds                             |
| `inputBufferBytes`      | 256 KiB                                |
| `reconnectDelay`        | bounded exponential backoff, unlimited |
| `maxReconnectDelayMs`   | 60 seconds                             |
| `createHandshakeId`     | `crypto.randomUUID`                    |
| `now`                   | `Date.now`                             |

`capacity` cannot exceed the v1 value of 1,024. `inputBufferBytes` cannot exceed
the v1 outstanding-credit limit of 16 MiB. Timeouts and the reconnect maximum
must be positive safe integers; `resumeExpirySkewMs` and resume expiry are
non-negative safe integers.

`createWebSocket` is a provider-owned authentication and socket-construction
hook. It receives the validated URL, exact protocol, and connection deadline
signal. Oxian still owns Open, subprotocol verification, and socket closure.

`onStateChange` is a nonblocking latest-value observer. A slow, throwing, or
re-entrant callback cannot gate the lifecycle. `onReenrollmentRequired` is a
nonblocking one-shot observer. Use snapshots and the `run()` result—not observer
completion—as authority.

## `createWorkerClient`

```ts
function createWorkerClient(
  options: WorkerClientOptions,
): WorkerClient;
```

The factory validates and copies identity, credentials, workload declarations,
limits, and persistence configuration. It returns a frozen client without
opening a socket.

```ts
const worker = createWorkerClient({
  url: "ws://127.0.0.1:8000/_oxian/workers/connect",
  allowInsecureLoopback: true,
  identity: {
    workerId: "echo-worker",
    attemptId: "attempt-1",
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: registrationCapability,
  },
  credentialPersistence: "ephemeral",
  workloads: { "echo.v1": echo },
  capacity: 4,
});

const running = worker.run();
await worker.whenReady();
// Later:
await worker.stop("service_shutdown");
await running;
```

## `WorkerClient`

```ts
type WorkerClient = Readonly<{
  run(): Promise<WorkerClientResult>;
  whenReady(): Promise<WorkerClientSnapshot>;
  stop(reason?: string): Promise<void>;
  snapshot(): WorkerClientSnapshot;
}>;
```

### `run`

`run()` may be called exactly once. It owns repeated connect, handshake,
credential rotation, initialization, work, heartbeat, drain, and reconnect
cycles until a terminal result:

```ts
type WorkerClientResult =
  | Readonly<{ reason: "shutdown" | "stopped" }>
  | Readonly<{
    reason: "reenrollment_required";
    error: unknown;
  }>
  | Readonly<{
    reason: "reconnect_exhausted";
    error: unknown;
  }>;
```

- `shutdown` means the current Hypervisor explicitly sent the terminal protocol
  frame.
- `stopped` means `stop()` or the external signal ended the client.
- `reenrollment_required` means the resume capability expired or authority
  permanently rejected it.
- `reconnect_exhausted` means reconnects were disabled, the policy returned
  `null`, or its attempt bound was exceeded.

Ordinary Hypervisor maintenance drain settles active work, sends `drained`,
closes that connection, and reconnects without treating the client as terminal.
The client also proactively drains and rotates before resume expiry.

### `whenReady`

Resolves once, after the first current `ready_ack`. Before that frame the client
does not send heartbeats, accept work, or report a false Ready state. It rejects
if the client terminates before ever becoming ready. It is not a per-reconnect
notification.

### `stop`

`stop(reason = "worker_stopped")` is idempotent. It aborts the current session
and causes `run()` to settle with `stopped`. Calling it before `run()` moves the
client directly to `stopped` and rejects `whenReady()`.

Stop does not wait for an arbitrary persistence, initialization, heartbeat,
observer, or reconnect-policy promise that ignored its advisory signal. It does
wait for output-source cancellation owned by handlers that actually started, so
a source with a never-settling `cancel()` can deliberately retain execution
capacity and final run settlement.

## State and snapshots

```ts
type WorkerClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "draining"
  | "drained"
  | "reconnecting"
  | "stopped";

type WorkerClientSnapshot = Readonly<{
  state: WorkerClientState;
  credentialKind: WorkerCredential["kind"];
  handshakeId: string;
  resumeExpiresAtMs?: number;
  connectionId?: string;
  activeStreams: number;
  occupiedExecutions: number;
  reconnectAttempt: number;
}>;
```

`snapshot()` is synchronous and frozen. `activeStreams` counts streams on the
current socket. `occupiedExecutions` is process-lifetime safety accounting:
handlers and output-source cancellations from a lost session remain occupied
until they truly settle. A replacement connection cannot oversubscribe that
capacity, and stale execution failure cannot terminate its newer session.

## Errors

```ts
type WorkerClientErrorCode =
  | "connection_lost"
  | "credential_expired"
  | "credential_rejected"
  | "credential_persistence_failed"
  | "handshake_failed"
  | "initialization_failed"
  | "invalid_server_message"
  | "reconnect_exhausted"
  | "worker_stopped";

type WorkerClientError =
  & Error
  & Readonly<{
    code: WorkerClientErrorCode;
    workerClientError: true;
    cause?: unknown;
  }>;
```

There is no exported error class, constructor, or type guard. The
`workerClientError: true` marker and `code` are stable structural
classifications. Messages and nested causes are diagnostic.
