# `jsr:@oxian/oxian-js@0.21.0-rc.4/hypervisor`

The Hypervisor hosts declared Worker transports, admits fenced sessions, assigns
work, and owns process-local drain/shutdown. It does not own a network listener
or force a database/credential manager abstraction.

Exports: `createHypervisor`, `createHypervisorConfig`,
`DEFAULT_HYPERVISOR_CONFIG`, `Hypervisor`, `HypervisorConfig`,
`HypervisorDisconnectEvent`, `HypervisorDisconnectPhase`,
`HypervisorDisconnectReason`, `HypervisorError`, `HypervisorErrorCode`,
`HypervisorHeartbeatContext`, `HypervisorListenOptions`, `HypervisorListener`,
`HypervisorOptions`, `HypervisorPeerClose`, `HypervisorReadyContext`,
`HypervisorRequestDecision`, `HypervisorScheduler`, and `HypervisorSnapshot`.

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
} from "jsr:@oxian/oxian-js@0.21.0-rc.4/hypervisor";

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
Workers, pending acceptance commits, and work counts by status.

Runtime failures use `HypervisorError` with `HypervisorErrorCode`:
authentication, connection loss, timeout, indeterminate acceptance, invalid
state, unavailable Worker, reschedulable work, shutdown, or work failure.

See [workers](../workers.md), [operations](../operations.md), and the
[protocol](../worker-protocol-v1.md).
