# `jsr:@oxian/oxian-js@0.20.0-rc.5/host`

[Back to the API reference](../api-reference.md)

The `/host` subpath is Oxian's transport-independent, embeddable worker
boundary. It routes work to handlers attached in the same JavaScript process
without a WebSocket, wire frames, credentials, or a Hypervisor listener.

```ts
import { createWorkerHost } from "jsr:@oxian/oxian-js@0.20.0-rc.5/host";

const host = createWorkerHost({
  persistAcceptance: async (commit) => {
    await operations.markAccepted(commit.operationId);
  },
});

host.attachInProcessWorker({
  workerId: "copilotz-engine",
  capacity: 8,
  workloads: {
    "copilotz.turn.v1": async ({ metadata, input, signal }) => {
      signal.throwIfAborted();
      return {
        metadata: { channel: metadata.channel ?? "text" },
        body: input,
      };
    },
  },
});

const work = await host.dispatch({
  workload: "copilotz.turn.v1",
  metadata: { channel: "audio" },
  body: audioInput,
});

await work.started;
const responseMetadata = await work.metadata;
await work.output.pipeTo(audioOutput);
const terminal = await work.completed;
```

The host is side-effect free until a worker is attached. Attaching starts only
an in-process heartbeat timer; it does not import modules, read files, bind a
port, install signal handlers, or create a thread.

## Export summary

### Values

| Export             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `createWorkerHost` | Create an embeddable process-local host and dispatch API. |

### Types

| Export                    | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `WorkerHostOptions`       | Acceptance, session, clock, scheduler, and identity hooks.      |
| `WorkerHost`              | Attach, dispatch, drain, shutdown, and snapshot operations.     |
| `WorkerHostInputBody`     | Direct byte array or streaming operation input.                 |
| `WorkerHostDispatchInput` | Workload, target, metadata, body, deadline, and signal.         |
| `WorkerHostWorkHandle`    | Started, metadata, output, completion, and cancellation handle. |
| `WorkerHostScheduler`     | Injectable runtime-neutral timer contract.                      |
| `WorkerHostSnapshot`      | Process-local worker, session, and operation counters.          |
| `WorkerHostErrorCode`     | Stable host operation error classification.                     |
| `WorkerHostError`         | Structurally classified host error.                             |
| `InProcessWorkerOptions`  | Logical ID, handlers, capacity, and owner signal.               |
| `InProcessWorkerState`    | Ready, drain, and stop lifecycle states.                        |
| `InProcessWorkerSnapshot` | One attached worker's current process-local state.              |
| `InProcessWorker`         | Attached worker identity, lifecycle, capacity, and snapshot.    |

## `createWorkerHost`

```ts
type WorkerHostOptions = Readonly<{
  persistAcceptance(commit: AcceptanceCommit): Promise<void>;
  sessions?: SessionRegistry;
  clock?: () => number;
  scheduler?: WorkerHostScheduler;
  createConnectionId?: () => string;
  createAttemptId?: () => string;
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
}>;

function createWorkerHost(options: WorkerHostOptions): WorkerHost;
```

`persistAcceptance` is required even in process. An attached handler reserves
capacity and claims the operation first. Oxian then awaits this hook and invokes
the handler only after the acceptance decision commits. A rejected hook leaves
the operation `indeterminate`; Oxian does not guess whether the owner crossed
its no-replay boundary.

For an ephemeral embedded application, an explicit `() => Promise.resolve()`
hook opts into process-local acceptance. Durable applications should atomically
associate the Oxian operation ID with their own command or transaction.

The default heartbeat interval is 10 seconds and the default lease is 30
seconds. Both are positive safe integers and the heartbeat must be shorter than
the lease. Clock, timer, and identifier hooks support deterministic tests or a
host runtime's own scheduling primitives.

The implementation uses standard JavaScript and Web APIs: promises,
`queueMicrotask`, `crypto.randomUUID`, `AbortSignal`, and Web Streams. The
`/host` source does not call `Deno`, Node, Bun, browser DOM elements, or
WebSocket APIs. The surrounding module loader and package distribution still
determine how an application imports Oxian in each runtime.

## Attaching in-process workers

```ts
type InProcessWorkerOptions = Readonly<{
  workerId: string;
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
}>;

type InProcessWorkerState =
  | "ready"
  | "draining"
  | "drained"
  | "stopping"
  | "stopped";

type InProcessWorker = Readonly<{
  readonly identity: WorkerIdentity;
  readonly workloads: readonly string[];
  readonly capacity: number;
  drain(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): InProcessWorkerSnapshot;
}>;
```

`host.attachInProcessWorker(options)` validates and copies the workload map,
creates a fenced process-local identity, publishes a ready session, and returns
an `InProcessWorker`. It rejects duplicate live worker IDs. A later attachment
after drain or shutdown receives a higher epoch.

`capacity` defaults to one. Session routing applies the same least-loaded and
exact-target rules as the supervisor registry. Set `target: { workerId: "..." }`
when work must remain sticky to one logical worker.

`drain()` immediately stops new reservations, waits for active handlers and
streams to settle, then detaches the session. `shutdown()` aborts active work
and waits for cooperative settlement before detaching. JavaScript cannot
forcibly interrupt a handler promise: handlers and stream sources must observe
their `AbortSignal` for prompt shutdown.

```ts
type InProcessWorkerSnapshot = Readonly<{
  state: InProcessWorkerState;
  identity: WorkerIdentity;
  connectionId: string;
  workloads: readonly string[];
  capacity: number;
  activeWork: number;
}>;
```

An in-process worker is a scheduling and lifecycle boundary, not a security,
memory, CPU, or failure-isolation boundary. CPU-bound workload code blocks the
same event loop unless the application explicitly moves that code to a runtime
worker thread or another process.

## Dispatch and streams

```ts
type WorkerHostInputBody =
  | Uint8Array
  | ReadableStream<Uint8Array>;

type WorkerHostDispatchInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
  metadata?: JsonObject;
  body?: WorkerHostInputBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

type WorkerHostWorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;
```

`host.dispatch(input)` resolves a handle after reserving a matching ready
worker. It rejects with `worker_unavailable` when no matching worker has free
capacity. Input metadata is validated, copied, and frozen by the dispatch
ledger.

The input and output remain live `ReadableStream<Uint8Array>` values. They are
not JSON-encoded, cloned, or split into WebSocket frames in the in-process path.
Web Streams propagate demand and cancellation, which makes the same workload
contract suitable for text, realtime audio, or another byte-oriented channel.
Media framing, codecs, turn-taking, and processor semantics belong to the
workload above Oxian.

`started` resolves only after durable acceptance and immediately before the
handler is invoked. A handler may call `sendMetadata()` once or return one
metadata object; returning no metadata resolves `{}`. `completed` resolves to
the supervisor's terminal `WorkDispatch`, including `completed`, `cancelled`,
`failed`, or `indeterminate` status. Runtime and stream failures reject the
relevant lifecycle and output promises while preserving that terminal record.

Cancelling the handle, cancelling its output stream, aborting the dispatch
signal, or reaching `deadlineAtMs` aborts the handler signal. Capacity remains
reserved until the handler and its stream source cooperatively settle.

## Host lifecycle and snapshots

```ts
type WorkerHost = Readonly<{
  dispatch(input: WorkerHostDispatchInput): Promise<WorkerHostWorkHandle>;
  attachInProcessWorker(options: InProcessWorkerOptions): InProcessWorker;
  drain(workerId: string): Promise<void>;
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): WorkerHostSnapshot;
  readonly sessions: SessionRegistry;
}>;

type WorkerHostSnapshot = Readonly<{
  acceptingWorkers: boolean;
  acceptingWork: boolean;
  workers: number;
  sessions: number;
  work: Readonly<Record<WorkDispatchStatus, number>>;
}>;
```

`drain(workerId)` and `shutdownWorker(workerId)` are no-ops when that worker is
not attached. `shutdown(reason)` is idempotent, stops all future attachment and
dispatch, and shuts down every attached worker. `sessions` exposes the same
read-only process-local routing authority used by the supervisor APIs.

Snapshots are frozen point-in-time values. Terminal dispatch entries are removed
after settlement, so the work counters describe only currently retained ledger
state rather than an operation history.

## Scheduler and errors

```ts
type WorkerHostScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

type WorkerHostErrorCode =
  | "indeterminate"
  | "invalid_state"
  | "shutting_down"
  | "worker_unavailable"
  | "work_failed";

type WorkerHostError =
  & Error
  & Readonly<{
    name: "WorkerHostError";
    code: WorkerHostErrorCode;
    identity?: WorkerIdentity;
    operationId?: string;
  }>;
```

Programmer input errors use `TypeError`. Host lifecycle, routing, acceptance,
and workload errors use `WorkerHostError`. Treat `identity` and `operationId` as
optional diagnostics: validation may fail before either value exists.
