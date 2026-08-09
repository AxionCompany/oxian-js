# Migrating to 0.21

Oxian 0.21 unifies in-process and WebSocket execution behind one Worker,
Hypervisor, protocol, lifecycle, frame codec, and flow-control implementation.
This is a breaking pre-1.0 release.

## Install

```ts
import {
  createHypervisor,
  createWorker,
} from "jsr:@oxian/oxian-js@0.21.0-rc.2";
```

## Topology declarations

Before, local Worker construction held a Hypervisor object directly:

```ts
const worker = createWorker({
  transport: { type: "in-process", hypervisor },
});
```

Now both roles declare the same visible rendezvous record:

```ts
const local = {
  type: "in-process",
  config: { topic: "my-engine" },
} as const;

const hypervisor = createHypervisor({ transports: [local] });
const worker = createWorker({
  id: "worker-1",
  transport: local,
  workloads,
});
```

A Hypervisor uses plural `transports`; a Worker uses singular `transport`.
Transport-specific fields always live under `config`:

```ts
const hostWss = {
  type: "websocket",
  config: { path: "/_oxian/workers/connect" },
} as const;

const workerWss = {
  type: "websocket",
  config: { url: "wss://example.com/_oxian/workers/connect" },
} as const;
```

The global `workerPath` config field is removed. The host path belongs only to
the WebSocket transport declaration.

## Worker lifecycle

Before:

```ts
const worker = createWorker(...);
const running = worker.run();
await worker.whenReady();
await running;
```

After:

```ts
const worker = createWorker(options, callbacks);
await worker.ready;
const terminal = await worker.closed;
await worker.stop("owner_shutdown");
```

Construction starts the lifecycle. The returned frozen capability exposes
`ready`, `closed`, `events`, `stop()`, and `snapshot()`.

## Functional activation and admission

The mandatory `WorkerRepository` and `RegistrationAuthority` manager objects,
their in-memory factories, and `admission: { authority, repository }` are
removed from the public API.

Close ordinary functions over your domain infrastructure:

```ts
const worker = createWorker({
  id: "worker-1",
  transport: workerWss,
  workloads,
  activate: ({ workerId }) => attempts.activate(workerId),
  register: ({ identity }) => credentials.issue(identity),
  handshake: ({ rotation, bootstrap }) =>
    workerState.persist(rotation, bootstrap),
}, workerCallbacks);

const hypervisor = createHypervisor({
  transports: [hostWss],
  admit: (context) => control.admit(context),
  assign: (context) => placement.select(context),
}, hypervisorCallbacks);
```

`admit` must preserve the old security semantics: complete-attempt fencing,
one-use credential exchange, exact lost-Welcome replay, monotonic session
generation, rotated resume credential, declaration validation, and bootstrap.

## Lifecycle callbacks

`sessionLifecycle.commitReady`, `commitHeartbeat`, and its disconnect observer
move to the second `createHypervisor` argument as `onReady`, `onHeartbeat`, and
`onDisconnect`.

The old `persistAcceptance` callback is removed. The work boundary is now
explicit:

```ts
createHypervisor(
  { transports, admit },
  {
    onWorkAssigned: assignments.record,
    onWorkAccepted: deliveries.commitAcceptance,
    onStart: audit.start,
    onComplete: deliveries.complete,
  },
);
```

`onWorkAssigned` runs before `work.open`. Hypervisor `onWorkAccepted` runs after
the Worker's real `work.accepted` frame and before `work.start`; it owns the
durable no-replay decision.

Worker callbacks use the same second-argument pattern:

```ts
createWorker(options, {
  onActivate,
  onRegister,
  onHandshake,
  onReady,
  onWorkAccepted,
  onStart,
  onComplete,
  onDisconnect,
});
```

Every context is immutable and has a stable `stageId`, callback attempt, and
`AbortSignal`. Treat awaited callbacks as idempotent gates.

## Supervisor subpath

The public `/supervisor` subpath is removed. Worker attempt, credential, and
presence repositories are application domain concerns. Public lifecycle contexts
carry the required data records and complete fences directly.

## Transport adapter names

The runtime-neutral callback seam is now `SocketConnection`; the canonical
bounded stream seam is `FrameConnection`. Standards-compatible sockets use
`adaptWebSocket`. Most applications need only the declarative transport records
and never touch these lower-level adapter contracts.

## Behavioral change for local execution

In-process work no longer invokes a handler through a direct shortcut. It now
crosses an addressed event fabric as the same encoded JSON/binary frames used by
WSS and executes the entire v1 lifecycle. This intentionally trades a small
local framing cost for one implementation and fault model.

The topic is a same-realm namespace, not work broadcast. Duplicate active topics
fail. Shutdown unregisters the binding. Use unique topics when embedding several
engines.

## Removed symbols checklist

Remove live-code references to:

- `WorkerHost`, `WorkerClient`, and their factories;
- `createInProcessTransport` and `connectToHypervisor`;
- `RegistrationAuthority`, `WorkerRepository`, and their in-memory factories;
- `persistAcceptance`;
- `workerPath`;
- direct `{ type: "in-process", hypervisor }` transport values; and
- Worker `run()` / `whenReady()` choreography.

## Verification

Run the same acceptance suite through local and WSS declarations. In particular,
verify Ready gating, exact-target routing, acceptance-before-Start, stream
credit/backpressure, cancellation crossing, reconnect/rotation, lease expiry,
drain, shutdown, and indeterminate no-replay behavior.

See [architecture](architecture.md), [workers](workers.md),
[operations](operations.md), and [runtime adapters](runtime-adapters.md).
