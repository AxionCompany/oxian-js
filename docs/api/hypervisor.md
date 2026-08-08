# `jsr:@oxian/oxian-js@0.20.0-rc.7/hypervisor`

The Hypervisor is Oxian's single hosting role. It routes work to Workers bound
in process or connected through the remote worker protocol. The portable core
does not own a native listener.

```ts
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorOptions,
} from "jsr:@oxian/oxian-js@0.20.0-rc.7/hypervisor";
```

## Exports

| Export                             | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `createHypervisor`                 | Create one closure-backed host capability.                    |
| `Hypervisor`                       | Dispatch, admission, lifecycle, and snapshot functions.       |
| `HypervisorOptions`                | Acceptance, optional remote admission, hooks, and config.     |
| `HypervisorAdmission`              | Declarative remote admission policy.                          |
| `WorkerAdmissionAuthority`         | Credential-exchange capability required for remote Workers.   |
| `WorkerAdmissionRepository`        | Current-definition checks required for remote Workers.        |
| `HypervisorConfig`                 | Validated protocol, capacity, timeout, and flow-control data. |
| `DEFAULT_HYPERVISOR_CONFIG`        | Frozen default configuration.                                 |
| `createHypervisorConfig`           | Validate and normalize partial configuration.                 |
| `HypervisorRequestDecision`        | Normal response or one-shot native upgrade admission.         |
| `HypervisorListenOptions`          | Runtime-neutral listener address and signal fields.           |
| `HypervisorListener`               | Address, completion, and shutdown capability.                 |
| `HypervisorSnapshot`               | Process-local connection, Worker, acceptance, and work state. |
| `HypervisorSessionLifecycle`       | Durable ready/heartbeat commits and disconnect observer.      |
| `HypervisorReadyCommitContext`     | Fenced data for a durable Ready commit.                       |
| `HypervisorHeartbeatCommitContext` | Fenced data for a durable heartbeat commit.                   |
| `HypervisorDisconnectEvent`        | Trusted lifecycle event for one ended connection.             |
| `HypervisorDisconnectPhase`        | Phase observed at disconnect.                                 |
| `HypervisorDisconnectReason`       | Hypervisor-authored disconnect classification.                |
| `HypervisorPeerClose`              | Untrusted peer close details retained for diagnostics.        |
| `HypervisorScheduler`              | Injectable timer capability for deterministic tests.          |
| `HypervisorErrorCode`              | Stable operation failure classification.                      |
| `HypervisorError`                  | Structurally typed Hypervisor error.                          |

Work input and output live in [`/work`](work.md) as `WorkInput`, `WorkHandle`,
`WorkBody`, and `Dispatcher` so embedding libraries do not need Hypervisor
implementation types.

## Construction

An in-process-only Hypervisor needs only the durable acceptance callback:

```ts
const hypervisor = createHypervisor({
  persistAcceptance: (commit) => operations.accept(commit),
});
```

Remote Workers add one admission descriptor:

```ts
const hypervisor = createHypervisor({
  admission: {
    type: "registered",
    authority,
    repository,
    bootstrap: ({ identity }) => ({ tenant: tenantFor(identity) }),
    validateReady: ({ metadata }) => validateRuntime(metadata),
  },
  persistAcceptance: (commit) => operations.accept(commit),
  sessionLifecycle,
  fallback: (request) => application.fetch(request),
});
```

```ts
type HypervisorOptions = Readonly<{
  admission?: HypervisorAdmission;
  persistAcceptance(commit: AcceptanceCommit): Promise<void>;
  sessionLifecycle?: HypervisorSessionLifecycle;
  config?: Partial<HypervisorConfig>;
  sessions?: SessionRegistry;
  fallback?: (request: Request) => Response | Promise<Response>;
  clock?: () => number;
  scheduler?: HypervisorScheduler;
  createConnectionId?: () => string;
}>;
```

Construction is side-effect free. It returns a frozen record of functions, not a
class instance.

## Remote admission

```ts
type HypervisorAdmission = Readonly<{
  type: "registered";
  authority: WorkerAdmissionAuthority;
  repository: WorkerAdmissionRepository;
  bootstrap?: (context) => JsonObject | Promise<JsonObject>;
  validateReady?: (context) => void | Promise<void>;
}>;
```

In-process binding is authorized by direct possession of the Hypervisor and does
not use this descriptor. Across WebSocket, identity names one exact Worker
attempt; the authority exchanges and rotates its credential; the repository
confirms that its definition and attempt remain current. These are admission
data, not additional runtime roles.

## Host capability

```ts
type Hypervisor = Readonly<{
  prepare(request: Request): HypervisorRequestDecision;
  dispatch(input: WorkInput): Promise<WorkHandle>;
  drain(workerId: string, reason?: string): Promise<void>;
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  shutdownSession(fence: SessionFence, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): HypervisorSnapshot;
  readonly config: HypervisorConfig;
  readonly sessions: SessionRegistry;
}>;
```

`dispatch()` selects a ready local or remote Worker with capacity unless
`input.target.workerId` names one. It returns after the operation is represented
by a streaming handle; execution starts only after `persistAcceptance` resolves.

`drain()` stops new reservations, waits for current work, and lets the Worker
replace that connection or direct binding. The Worker keeps its identity,
publishes a newer session generation, and reruns `beforeReady` with
`reconnecting: true`. `shutdownWorker()` requests terminal Worker shutdown.
`shutdownSession()` is fenced to one exact connection so stale cleanup cannot
terminate its replacement. `shutdown()` covers every Worker bound to this
Hypervisor but does not claim runtime-adapter listener ownership.

## Runtime adapter seam

`prepare(request)` returns a `HypervisorRequestDecision`:

- `kind: "response"` contains a normal response or fallback result;
- `kind: "upgrade"` reserves admission and exposes the exact protocol plus
  one-shot `attach(connection)` and `cancel(reason)` functions.

A runtime adapter performs its native handshake and supplies a
`WorkerWireConnection`. Deno applications can use `handler(hypervisor)` or
`serve({ hypervisor })` from [`/adapters/deno`](adapters/deno.md).

Without `admission`, the configured Worker WebSocket path returns 404 while
normal fallback requests continue to work.

## Durable lifecycle hooks

`HypervisorSessionLifecycle` has three functions:

- `commitReady(HypervisorReadyCommitContext)` gates publication of a remote
  ready session;
- `commitHeartbeat(HypervisorHeartbeatCommitContext)` gates heartbeat state;
- `onDisconnect(HypervisorDisconnectEvent)` observes one fenced disconnect
  without delaying socket cleanup.

Ready and heartbeat stores must compare the complete fence and retain a
monotonic disconnect tombstone so a late commit cannot resurrect an ended
session. `HypervisorDisconnectReason` is trusted and authored locally;
`HypervisorPeerClose` is untrusted peer text.

## Snapshot and configuration

`HypervisorSnapshot` reports local and remote session counts, in-process Worker
count, connection admission, pending acceptance commits, and counts for each
dispatch status. It is process-local, not a durable global directory.

`createHypervisorConfig()` merges a partial `HypervisorConfig` with
`DEFAULT_HYPERVISOR_CONFIG`, validates bounds and relationships, and freezes the
result. Configuration covers paths, connection and handshake bounds, heartbeat
and lease timing, drain/shutdown timing, capacity, frame queues, stream credit,
and protocol limits.

`HypervisorListenOptions` and `HypervisorListener` are runtime-neutral contracts
shared with server adapters. The core itself never binds a port.

## Errors and scheduling

`HypervisorError` is an ordinary `Error` augmented with a `HypervisorErrorCode`
and optional identity or operation ID. It is not a custom class. Codes classify
authentication, connection, timeout, state, availability, rescheduling,
shutdown, indeterminate acceptance, and workload failures.

`HypervisorScheduler` is a two-function timer capability (`schedule` and
`cancel`) used for deterministic tests or unusual runtimes; normal callers use
the default Web timer implementation.
