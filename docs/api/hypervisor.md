# `jsr:@oxian/oxian-js@0.22.0/hypervisor`

The Hypervisor hosts declared Worker transports, admits fenced sessions, assigns
work, and owns process-local drain/shutdown. It does not own a network listener
or force a database/credential manager abstraction.

Exports: `createHypervisor`, `createHypervisorConfig`,
`DEFAULT_HYPERVISOR_CONFIG`, `Hypervisor`, `HypervisorConfig`,
`HypervisorDisconnectEvent`, `HypervisorDisconnectPhase`,
`HypervisorDisconnectReason`, `HypervisorError`, `HypervisorErrorCode`,
`HypervisorHeartbeatContext`, `HypervisorListenOptions`, `HypervisorListener`,
`HypervisorOptions`, `HypervisorPeerClose`, `HypervisorReadyContext`,
`HypervisorRequestDecision`, `HypervisorScheduler`, `HypervisorSnapshot`,
`WorkerCallAdmission`, `WorkerCallContext`, `WorkerCallHandler`, and
`WorkerCallOptions`.

Root lifecycle contracts used here are `HypervisorAdmit`,
`HypervisorAdmitContext`, `HypervisorAdmission`, `HypervisorAssign`,
`HypervisorAssignContext`, `HypervisorCompleteContext`,
`HypervisorLifecycleCallbacks`, `HypervisorStartContext`,
`HypervisorWorkLifecycleContext`, `HypervisorWorkAcceptedContext`, and
`HypervisorWorkAssignedContext`.

## Create

```ts
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorOptions,
} from "jsr:@oxian/oxian-js@0.22.0/hypervisor";

const local = {
  type: "in-process",
  config: { topic: "orders" },
} as const;

const hypervisor = createHypervisor(
  {
    transports: [local, {
      type: "websocket",
      config: { path: "/_oxian/workers/connect" },
    }],
    admit,
    assign,
    signal,
  },
  {
    onReady,
    onHeartbeat,
    onWorkAssigned,
    onWorkAccepted,
    onStart,
    onComplete,
    onDisconnect,
  },
);
```

`createHypervisor(options, callbacks)` returns a frozen `Hypervisor` capability.
`HypervisorOptions` requires plural declarative `transports` and accepts
functional `admit` / `assign` policy, `AbortSignal`, bounded configuration, and
an optional Fetch fallback.

## Capability

`Hypervisor` exposes:

- `prepare(request): HypervisorRequestDecision` for runtime-owned HTTP/WSS
  ingress;
- `dispatch(input)` for streaming work;
- `drain(workerId)` for maintenance rotation;
- `shutdownWorker(workerId)` for terminal logical-Worker shutdown;
- `shutdownSession(fence)` for exact-generation cleanup;
- `shutdown()` for all owned bindings/connections; and
- `snapshot(): HypervisorSnapshot` plus validated `config` and read-only
  process-local session diagnostics.

A `HypervisorRequestDecision` is either a normal response or a one-shot upgrade
capability with `attach()` and `cancel()`. Runtime adapters attach a
`SocketConnection` only after negotiating the exact protocol.

## Dispatch waiting

`dispatch(input)` returns a `Promise<WorkHandle>`. Enable bounded pre-offer
waiting with `config.maxQueuedDispatches > 0`; its default `0` preserves
immediate `worker_unavailable` when capacity or a target is unavailable. The
queue limit is an integer from 0 to 1,000,000. `dispatchQueueTimeoutMs` defaults
to 30,000 and accepts positive integers up to 2,147,483,647.

The effective pre-dispatch deadline is the earlier of `input.deadlineAtMs` and
arrival plus `dispatchQueueTimeoutMs`. It now covers the complete entry-to-Open
lifecycle in both queue modes, including `assign` and `onWorkAssigned`; neither
hook gets a fresh timeout. Absent targets may reconnect until that deadline;
untargeted requests also wait. The configured timeout does not impose a work
execution timeout after Open. Explicit targets have independent FIFO
lanes; untargeted requests have separate FIFO lanes per workload. Busy targets
never block other targets using the same workload. Runnable lane heads compete
in arrival order for available slots; asynchronous assignment owns no slot until
reservation, and there is no cross-class FIFO guarantee.

While queued, a request has no offer and its body is untouched. Rejection uses
`dispatch_queue_full`, `deadline_exceeded`, `dispatch_aborted`, `shutting_down`,
or `worker_draining`. The caller's abort reason is retained as `cause`. The
queue limit includes async assignment calls and applies globally. `assign` may
run again after a capacity or fence race, with stable stage ID, incremented
callback attempt, and a signal aborted by queue cancellation. Returned fences
are revalidated before reservation. Existing offered and accepted work is never
automatically replayed by this queue.

`config.maxPendingDispatchHooks` separately bounds all unsettled `assign` and
`onWorkAssigned` calls (default 1,024; positive integer up to 1,000,000). A full
hook budget refuses with `dispatch_hook_capacity`; it does not wait behind work
it might unblock. `HypervisorSnapshot.pendingDispatchHooks` includes calls whose
caller already timed out or cancelled. Their occupancy is released only when
the actual callback promise settles, including across session replacement.
An unsettled `onWorkAssigned` also retains its offered session reservation until
settlement, unless the session itself is lost. No late callback can open work
after cancellation, deadline, drain, shutdown or assignment replacement.
Custom session registries without `subscribe` are checked at most every 25 ms
while pre-Open work waits; subscribed registries detect transitions synchronously.
The callback signal is advisory: cooperate with cancellation and do not perform
external work in selection/assignment policy. Finite timeout bounds caller
waiting, not a noncooperative callback's JavaScript execution.

Drain and Worker shutdown reject queued explicit targets, including absent ones;
untargeted requests may use other Workers. New requests to a draining session
reject, but after detach they may wait for a replacement. Hypervisor shutdown
rejects all pending pre-Open and future requests. An assigned-but-unopened
request also refuses on drain or replacement; already-started work retains the
ordinary graceful-drain contract. Deadline timers and cancellation listeners are
removed when the caller settles; unresolved hook occupancy remains charged. See
[operations](../operations.md#bounded-dispatch-waiting) for usage and body
ownership.

## Lifecycle

The second argument is `HypervisorLifecycleCallbacks` (exported by the package
root). Its relevant context types are `HypervisorAdmitContext`,
`HypervisorAdmission`, `HypervisorAssignContext`, `HypervisorAssign`,
`HypervisorWorkAssignedContext`, `HypervisorWorkAcceptedContext`,
`HypervisorStartContext`, `HypervisorCompleteContext`, `HypervisorReadyContext`,
`HypervisorHeartbeatContext`, and `HypervisorDisconnectEvent`.

Hypervisor work callbacks extend `HypervisorWorkLifecycleContext` and therefore
carry both the application operation ID and its connection-local stream ID.
`onWorkAccepted` additionally receives the immutable target, deadline, delivery
count, exact assignment, and acceptance timestamp that crossed the no-replay
boundary. Durable adapters do not need to reconstruct these values from live
session state.

Ready and heartbeat are fenced fail-closed gates. `onWorkAssigned` precedes
Open. Hypervisor `onWorkAccepted` follows the Worker's ACK and is the durable
no-replay gate before Start. `onDisconnect` is nonblocking and exactly once per
fenced connection.

`HypervisorDisconnectPhase` identifies the last trusted phase.
`HypervisorDisconnectReason` is Hypervisor-authored policy; untrusted native
close details are isolated in `HypervisorPeerClose`.

## Configuration

`DEFAULT_HYPERVISOR_CONFIG` is immutable. Use `createHypervisorConfig(partial)`
to validate a `HypervisorConfig` directly, or pass `config` into
`createHypervisor`.

The config bounds handshake/Ready deadlines, heartbeat and lease timing,
shutdown/cancellation, WebSocket connection age, connection counts, acceptance
commits, message/byte buffering, Worker capacity, lifetime streams, payload
size, and credit. Process-local event-fabric connections do not rotate by age:
they have no intermediary socket lifetime and may carry application-lifetime
streams. WebSocket path is not global configuration; it belongs to
`transports[].config.path`.

`HypervisorScheduler`, `HypervisorListenOptions`, and `HypervisorListener` are
runtime integration contracts. Deno listener ownership is implemented by the
explicit `/adapters/deno` subpath.

## Snapshots and errors

`HypervisorSnapshot` reports connection/admission/session counts, ready local
Workers, pending dispatch hooks, pending acceptance commits, and work counts by status. It also exposes
`queuedDispatches` and immutable `queuedDispatchesByLane` groups containing
`workload`, optional `workerId`, and `count`. Queue entries are unoffered and
are not part of `WorkDispatchStatus`.

Runtime failures use `HypervisorError` with `HypervisorErrorCode`:
authentication, connection loss, timeout, indeterminate acceptance, invalid
state, unavailable Worker, reschedulable work, shutdown, or work failure.

See [workers](../workers.md), [operations](../operations.md), and the
[protocol](../worker-protocol-v1.md).

## Worker-to-host admission

`HypervisorOptions.workerCalls` opts into host workloads. The exported
`WorkerCallOptions`, `WorkerCallAdmission`, `WorkerCallHandler`, and
`WorkerCallContext` describe this boundary:

```ts
type WorkerCallOptions = Readonly<{
  admit: WorkerCallAdmission;
  admitUnassigned?: WorkerCallAdmission;
  maxConcurrent?: number;
  maxPerConnection?: number;
  timeoutMs?: number;
}>;
```

`admit(context)` authorizes a current assigned call and returns a handler or
`undefined`; it may return a promise. Admission must perform no invocation
effects. The handler runs only after Start and receives credited `input` and an
abort `signal`. It returns `WorkerWorkResult`.

`WorkerCallContext` contains host-authenticated `fence` and `definition`, the
requested `workload`, untrusted call `metadata`, and a bound `signal`. For an
assigned call, `parent` contains the host's current assignment `operationId`,
`streamId`, `workload`, and `metadata`. Session and parent validity are checked
again before handler entry. Application grants, forwarded-client authority,
owner epochs, transaction fences, and receipts remain application policy.

Parentless calls require the separate `admitUnassigned` callback and are denied
by default. They are available only on ready connections. Assigned calls can
continue during drain while their authenticated parent remains active.

Host limits default to 32 concurrent calls, min(16, maxConcurrent) per
connection, and a 30-second timeout. Limits include unresolved admission and
handler/source cleanup across connection loss. Excess calls refuse rather than
joining the forward dispatch queue. See the
[complete call guide](../worker-host-calls.md) for limits and ambiguity
recovery.
