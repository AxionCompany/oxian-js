# `jsr:@oxian/oxian-js@0.20.0-rc.6/hypervisor`

[Back to the API reference](../api-reference.md)

The `/hypervisor` subpath creates the process-local Oxian protocol and session
core. It prepares authenticated outbound-worker admission, publishes fenced
ready sessions, dispatches multiplexed work, commits the no-replay boundary, and
drains or shuts down attached connections. Runtime adapters own native WebSocket
upgrades and listeners.

```ts
import {
  createHypervisor,
  createHypervisorConfig,
  DEFAULT_HYPERVISOR_CONFIG,
} from "jsr:@oxian/oxian-js@0.20.0-rc.6/hypervisor";
```

The Hypervisor owns only sessions connected to this JavaScript process. It is
not a durable worker directory, distributed socket relay, provider manager, or
operation-result store.

## Export summary

### Values

| Export                      | Purpose                                        |
| --------------------------- | ---------------------------------------------- |
| `DEFAULT_HYPERVISOR_CONFIG` | Frozen bounded configuration defaults.         |
| `createHypervisorConfig`    | Validate overrides and return a frozen config. |
| `createHypervisor`          | Create a side-effect-free gateway instance.    |

### Types

| Export                             | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `HypervisorConfig`                 | Complete gateway timing and admission configuration.      |
| `HypervisorWorkInputBody`          | Byte array or streaming dispatch input.                   |
| `HypervisorDispatchInput`          | Workload, target, metadata, body, and cancellation input. |
| `HypervisorWorkHandle`             | One dispatched operation's streaming lifecycle.           |
| `HypervisorScheduler`              | Injectable timer abstraction.                             |
| `HypervisorReadyCommitContext`     | Durable Ready hook input.                                 |
| `HypervisorHeartbeatCommitContext` | Durable heartbeat hook input.                             |
| `HypervisorDisconnectPhase`        | Last trusted lifecycle phase at disconnect.               |
| `HypervisorDisconnectReason`       | Hypervisor-authored disconnect classification.            |
| `HypervisorPeerClose`              | Untrusted peer WebSocket close details.                   |
| `HypervisorDisconnectEvent`        | Exactly-once disconnect observation.                      |
| `HypervisorSessionLifecycle`       | Durable session-status integration seam.                  |
| `WorkerAdmissionRepository`        | Read-only repository projection used by admission.        |
| `WorkerAdmissionAuthority`         | Registration exchange projection used by admission.       |
| `HypervisorOptions`                | Gateway dependencies, lifecycle hooks, and overrides.     |
| `HypervisorRequestDecision`        | Normal response or one-shot connection admission.         |
| `HypervisorListenOptions`          | Shared settings used by listener-capable adapters.        |
| `HypervisorListener`               | Shared listener lifecycle handle used by adapters.        |
| `HypervisorSnapshot`               | Process-local connection and work counters.               |
| `Hypervisor`                       | Gateway API.                                              |
| `HypervisorErrorCode`              | Stable operation-level error classification.              |
| `HypervisorError`                  | Structurally classified Hypervisor error.                 |

## Configuration

### `HypervisorConfig`

```ts
type HypervisorConfig = Readonly<{
  workerPath: string;
  handshakeTimeoutMs: number;
  readyTimeoutMs: number;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  leaseSweepIntervalMs: number;
  shutdownTimeoutMs: number;
  cancellationAckTimeoutMs: number;
  maxConnectionAgeMs: number;
  proactiveDrainMarginMs: number;
  maxConnections: number;
  maxUnauthenticatedConnections: number;
  maxAuthenticatedConnections: number;
  maxPendingAcceptanceCommits: number;
  maxPendingAcceptanceCommitsPerWorker: number;
  maxInboundMessages: number;
  maxInboundBytes: number;
  maxBufferedAmountBytes: number;
  maxWorkerCapacity: number;
  maxLifetimeStreams: number;
  maxDataPayloadBytes: number;
  maxReceiveCreditBytes: number;
}>;
```

### `DEFAULT_HYPERVISOR_CONFIG`

The exported value is frozen.

| Field                                  | Default                   |
| -------------------------------------- | ------------------------- |
| `workerPath`                           | `/_oxian/workers/connect` |
| `handshakeTimeoutMs`                   | 10 seconds                |
| `readyTimeoutMs`                       | 5 minutes                 |
| `heartbeatIntervalMs`                  | 10 seconds                |
| `leaseTimeoutMs`                       | 30 seconds                |
| `leaseSweepIntervalMs`                 | 1 second                  |
| `shutdownTimeoutMs`                    | 30 seconds                |
| `cancellationAckTimeoutMs`             | 10 seconds                |
| `maxConnectionAgeMs`                   | 50 minutes                |
| `proactiveDrainMarginMs`               | 1 minute                  |
| `maxConnections`                       | 10,000                    |
| `maxUnauthenticatedConnections`        | 128                       |
| `maxAuthenticatedConnections`          | 10,000                    |
| `maxPendingAcceptanceCommits`          | 1,024                     |
| `maxPendingAcceptanceCommitsPerWorker` | 64                        |
| `maxInboundMessages`                   | 256                       |
| `maxInboundBytes`                      | 16 MiB                    |
| `maxBufferedAmountBytes`               | 4 MiB                     |
| `maxWorkerCapacity`                    | 1,024                     |
| `maxLifetimeStreams`                   | 65,536                    |
| `maxDataPayloadBytes`                  | 1 MiB                     |
| `maxReceiveCreditBytes`                | 16 MiB                    |

The final four defaults are the `oxian.worker.v1` hard limits. A gateway may
choose smaller values but cannot raise them.

### `createHypervisorConfig`

```ts
function createHypervisorConfig(
  input?: Partial<HypervisorConfig>,
): HypervisorConfig;
```

Applies defaults, validates every field, and returns a new frozen object.
`workerPath` must be one canonical absolute path: no trailing slash, authority,
query, fragment, backslash, dot segment, or percent-encoded spelling that
changes its URL pathname.

Timers must be positive safe integers no greater than `2_147_483_647`.
Configuration also enforces these relationships:

- `leaseTimeoutMs > heartbeatIntervalMs`;
- `leaseSweepIntervalMs < leaseTimeoutMs`;
- unauthenticated and authenticated limits do not exceed `maxConnections`;
- the per-worker acceptance-commit limit does not exceed the global limit;
- `proactiveDrainMarginMs < maxConnectionAgeMs`; and
- inbound and buffered byte bounds each fit one configured binary frame,
  including its 28-byte header.

Other implementation caps are one million connections/commit slots, 65,536
queued inbound messages, 256 MiB inbound bytes, and 64 MiB WebSocket buffered
bytes. Invalid values or relationships throw `TypeError`.

## Admission and lifecycle dependencies

### Repository and authority projections

```ts
type WorkerAdmissionRepository = Pick<
  WorkerRepository,
  "getDefinition" | "assertCurrent"
>;

type WorkerAdmissionAuthority = Pick<
  RegistrationAuthority,
  "exchange"
>;
```

The data plane can read and fence attempts and exchange credentials. It cannot
define workers, activate attempts, issue registrations, revoke authority, or
change provider state. Those remain Control-plane responsibilities.

### Session lifecycle hooks

```ts
type HypervisorReadyCommitContext = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  metadata: JsonObject;
  signal: AbortSignal;
}>;

type HypervisorHeartbeatCommitContext = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  metadata: JsonObject;
  signal: AbortSignal;
}>;

type HypervisorSessionLifecycle = Readonly<{
  commitReady(
    context: HypervisorReadyCommitContext,
  ): void | Promise<void>;
  commitHeartbeat(
    context: HypervisorHeartbeatCommitContext,
  ): void | Promise<void>;
  onDisconnect(event: HypervisorDisconnectEvent): void;
}>;
```

`commitReady` and `commitHeartbeat` are ordered, fail-closed gates. They run in
the connection's frame loop before process-local state is published. A rejection
ends that session. Durable implementations must compare the complete fence and
retain a monotonic disconnect tombstone or high-water mark so a late promise
cannot resurrect a disconnected fence.

The hook signals are advisory; arbitrary promises cannot be forcibly cancelled.
Hooks must not await work whose completion needs another frame from the same
worker, including `dispatch()` or `drain()`, because the ordered frame loop
would deadlock. Enqueue follow-on orchestration elsewhere.

`onDisconnect` is invoked exactly once when an admitted fenced connection is
cleaned up. It is a nonblocking observer: thrown errors and returned promises
never delay socket cleanup or Hypervisor shutdown.

### Disconnect values

```ts
type HypervisorDisconnectPhase =
  | "authenticated"
  | "connected"
  | "ready"
  | "draining"
  | "drained"
  | "expired";

type HypervisorDisconnectReason =
  | "authentication_rejected"
  | "connection_failed"
  | "drain_failed"
  | "drain_timeout"
  | "handshake_timeout"
  | "lease_expired"
  | "peer_closed"
  | "protocol_rejected"
  | "ready_timeout"
  | "rotation"
  | "session_replaced"
  | "shutdown"
  | "shutdown_timeout"
  | "stale_session"
  | "work_stream_failed";

type HypervisorPeerClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

type HypervisorDisconnectEvent = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  phase: HypervisorDisconnectPhase;
  reason: HypervisorDisconnectReason;
  peerClose?: HypervisorPeerClose;
  disconnectedAtMs: number;
}>;
```

`reason` is trusted and authored by the Hypervisor. `peerClose.reason` is
untrusted remote text for diagnostics only; never use it for authorization,
durable transitions, or retry policy.

## `HypervisorOptions`

```ts
type HypervisorOptions = Readonly<{
  authority: WorkerAdmissionAuthority;
  repository: WorkerAdmissionRepository;
  persistAcceptance(commit: AcceptanceCommit): Promise<void>;
  createBootstrap?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      signal: AbortSignal;
    }>,
  ): JsonObject | Promise<JsonObject>;
  validateReady?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      sessionGeneration: number;
      connectionId: string;
      metadata: JsonObject;
      signal: AbortSignal;
    }>,
  ): void | Promise<void>;
  sessionLifecycle?: HypervisorSessionLifecycle;
  config?: Partial<HypervisorConfig>;
  sessions?: SessionRegistry;
  fallback?: (request: Request) => Response | Promise<Response>;
  clock?: () => number;
  scheduler?: HypervisorScheduler;
  createConnectionId?: () => string;
}>;
```

The required dependencies are:

- `authority.exchange`, which authenticates the registration or resume
  credential and returns a monotonically fenced session generation;
- `repository.getDefinition` and `repository.assertCurrent`, which verify the
  complete worker attempt and declared workloads/capacity; and
- `persistAcceptance`, which durably records the worker claim before Oxian sends
  `work.start`.

`persistAcceptance` is the no-replay transaction. A rejection is conservatively
indeterminate: the worker reservation is cancelled, but the operation is never
automatically replayed because the durable outcome is unknown.

`createBootstrap` returns opaque workload-owned JSON for `welcome`; `{}` is the
default. `validateReady` may reject invalid workload-owned Ready metadata but
must have no durable or externally visible side effects. Durable Ready state
belongs in `sessionLifecycle.commitReady`.

`sessions` defaults to a new process-local `SessionRegistry`. Supplying one is
useful for composition and tests, but it still must represent sockets owned by
this process. `clock`, `scheduler`, and `createConnectionId` are deterministic
injection points; application code normally leaves them unset.

```ts
type HypervisorScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;
```

## `createHypervisor`

```ts
function createHypervisor(options: HypervisorOptions): Hypervisor;
```

Construction validates dependencies and configuration but opens no listener and
starts no worker connection. The returned object is frozen.

```ts
import {
  createHttpGateway,
  type HttpDispatch,
} from "jsr:@oxian/oxian-js@0.20.0-rc.6/http";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.6/hypervisor";

// The HTTP gateway and Hypervisor are circular by design. Keep their seam
// explicitly typed, then bind it after construction and before serving.
let dispatch: HttpDispatch = () =>
  Promise.reject(new Error("Hypervisor dispatch is not bound"));
const gateway = createHttpGateway({
  dispatch: (input) => dispatch(input),
});
const hypervisor = createHypervisor({
  authority,
  repository,
  persistAcceptance: (commit) => acceptedOperations.put(commit),
  fallback: gateway,
});
dispatch = hypervisor.dispatch;
```

Missing or malformed required dependencies throw `TypeError` during
construction. The factory also validates that a supplied `sessionLifecycle`
implements all three methods.

## `Hypervisor`

```ts
type Hypervisor = Readonly<{
  prepare(request: Request): HypervisorRequestDecision;
  dispatch(input: HypervisorDispatchInput): Promise<HypervisorWorkHandle>;
  drain(workerId: string, reason?: string): Promise<void>;
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  shutdownSession(fence: SessionFence, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): HypervisorSnapshot;
  readonly config: HypervisorConfig;
  readonly sessions: SessionRegistry;
}>;
```

### `prepare`

`prepare` is the runtime-neutral server seam. Only the exact configured
`workerPath` is treated as worker admission; every other request produces a
response decision from `fallback` or `404`.

```ts
type HypervisorRequestDecision =
  | Readonly<{
    kind: "response";
    response: Response | Promise<Response>;
  }>
  | Readonly<{
    kind: "upgrade";
    protocol: string;
    attach(
      connection: WorkerWireConnection,
      negotiatedProtocol?: string,
    ): void;
    cancel(reason?: string): void;
  }>;
```

Worker admission requires:

- the Hypervisor still accepts connections;
- `GET`;
- a WebSocket upgrade;
- the exact `oxian.worker.v1` subprotocol header; and
- available total and unauthenticated admission capacity.

Failures produce `405`, `426`, or `503` responses before a socket is created. An
accepted decision reserves admission capacity before the runtime handshake. The
server adapter must call exactly one of `attach()` or `cancel()`; an unconsumed
decision expires on the handshake deadline. After attachment, protocol and
authentication failures are reported with a bounded `protocol_error` when
possible and a stable 4xxx close reason.

### Server ownership

```ts
type HypervisorListenOptions = Readonly<{
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;

type HypervisorListener = Readonly<{
  hostname: string;
  port: number;
  url: URL;
  finished: Promise<void>;
  shutdown(): Promise<void>;
}>;
```

These listener contracts are implemented by listener-capable runtime adapters;
they are not methods on the portable `Hypervisor`.

For Deno, `createDenoHypervisor` from [`/adapters/deno`](adapters/deno.md)
returns the core plus `fetch()` and `listen()` conveniences.
`createDenoHypervisorFetch` adapts an existing core to an application-owned
`Deno.serve`, including TLS termination. Other runtimes adapt `prepare()` to
their native upgrade model and attach a `WorkerWireConnection`.

## Dispatch

### Types

```ts
type HypervisorWorkInputBody =
  | Uint8Array
  | ReadableStream<Uint8Array>;

type HypervisorDispatchInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
  metadata?: JsonObject;
  body?: HypervisorWorkInputBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

type HypervisorWorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;
```

`dispatch()` selects and reserves one current ready session through the
supervisor. `target` can constrain that selection. `deadlineAtMs` is an absolute
timestamp and must still be in the future when offered.

The body is sent only after `work.start` and is governed by peer credit. A
direct `Uint8Array` may be larger and is segmented by Oxian. Every chunk
produced by a `ReadableStream` must already fit `config.maxDataPayloadBytes`;
non-byte or oversized stream chunks cancel the operation.

The returned handle exposes distinct milestones:

- `started` resolves only after `work.accepted` was durably committed and
  `work.start` entered the ordered send path;
- `metadata` resolves on the worker's single response metadata frame;
- `output` is the credited response byte stream;
- `completed` resolves with the final supervisor dispatch state; and
- `cancel()` requests directional cancellation and resolves with that same final
  state after acknowledgement or connection settlement.

Cancelling `output` calls `cancel()`. The input signal also requests
cancellation and is detached when `completed` settles. Failure before the
durable acceptance commit may produce a `reschedulable` final dispatch. Failure
after it is `indeterminate`; the Hypervisor never replays accepted work.

If no session matches, the session disappears before `work.open`, the deadline
already elapsed, or the gateway is shutting down, `dispatch()` rejects. Once
`work.open` occupies the ordered send queue, later setup and transport failures
settle through the returned handle instead of being reported as definitely
undelivered.

## Drain and shutdown

`drain(workerId, reason = "requested")` stops new reservations on the current
ready session, sends `drain`, waits for active streams and `drained`, then
closes the socket for rotation. A conforming indefinitely running `WorkerClient`
reconnects with its resume credential.

`shutdownWorker(workerId, reason = "worker_shutdown")` uses the same graceful
drain but then sends `shutdown`. The worker's `run()` settles with
`{ reason: "shutdown" }` and does not reconnect. If a maintenance drain is
already active, this call upgrades it to terminal shutdown.

`shutdownSession(fence, reason = "session_shutdown")` is the attempt-safe
variant. It is a no-op unless every identity, generation, and connection field
still names the exact current session, so stale cleanup cannot stop a
replacement connection.

All three methods are no-ops when their target is absent. They do not revoke
credentials, terminate provider compute, or mutate the durable worker attempt.

`shutdown(reason = "hypervisor_shutdown")` is idempotent. It immediately stops
new connections, gracefully shuts down current sessions, force-closes any
remainder, closes all built-in listeners, and stops lease sweeping.

## Snapshots

```ts
type HypervisorSnapshot = Readonly<{
  acceptingConnections: boolean;
  connections: number;
  unauthenticatedConnections: number;
  authenticatedConnections: number;
  handshakeOperations: number;
  readyOperations: number;
  sessions: number;
  pendingAcceptanceCommits: number;
  pendingAcceptanceCommitsByWorker: readonly Readonly<{
    workerId: string;
    count: number;
  }>[];
  work: Readonly<Record<WorkDispatchStatus, number>>;
}>;
```

`snapshot()` is synchronous and process-local. External authority, repository,
bootstrap, Ready, and heartbeat promises remain counted after a socket abort
until the underlying promise actually settles, preventing hung integrations from
bypassing admission limits.

`work` includes every dispatch status: `offered`, `claimed`, `committing`,
`committed`, `cancelling`, `reschedulable`, `completed`, `cancelled`, `failed`,
and `indeterminate`. Per-worker acceptance counts are sorted by worker ID.

## Errors

```ts
type HypervisorErrorCode =
  | "authentication_failed"
  | "connection_lost"
  | "handshake_timeout"
  | "indeterminate"
  | "invalid_state"
  | "worker_unavailable"
  | "reschedulable"
  | "shutting_down"
  | "work_failed";

type HypervisorError =
  & Error
  & Readonly<{
    name: "HypervisorError";
    code: HypervisorErrorCode;
    identity?: WorkerIdentity;
    operationId?: string;
  }>;
```

There is no exported error class or constructor. Catch structurally and treat
`code` as the stable classification; messages are diagnostic. Work-related
errors include the fenced worker identity and operation ID when available.
