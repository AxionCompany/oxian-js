# `jsr:@oxian/oxian-js@0.21.0-rc.6/worker`

This subpath creates auto-starting functional Workers and defines workload,
stream, snapshot, reconnect, and error contracts.

Exports: `createBoundedExponentialBackoff`, `createWorker`,
`BoundedExponentialBackoffOptions`, `Worker`, `WorkerBeforeReadyContext`,
`WorkerBody`, `WorkerError`, `WorkerErrorCode`, `WorkerHeartbeatContext`,
`WorkerOptions`, `WorkerReconnectContext`, `WorkerReconnectDelay`,
`WorkerResult`, `WorkerResumeCredentialPersister`,
`WorkerResumeCredentialUpdate`, `WorkerSnapshot`, `WorkerState`,
`WorkerWebSocketLimits`, `WorkerWorkContext`, `WorkerWorkHandler`, and
`WorkerWorkResult`.

Root lifecycle contracts used here are `LifecycleContext`, `LifecycleStage`,
`WorkerWorkLifecycleContext`, `WorkerActivate`, `WorkerActivationContext`,
`WorkerActivationResult`, `WorkerCompleteContext`, `WorkerHandshake`,
`WorkerHandshakeContext`, `WorkerLifecycleCallbacks`, `WorkerLifecycleEvent`,
`WorkerRegister`, `WorkerRegistration`, `WorkerRegistrationContext`,
`WorkerStartContext`, and `WorkerWorkAcceptedContext`.

## Create

```ts
import {
  createWorker,
  type Worker,
  type WorkerOptions,
} from "jsr:@oxian/oxian-js@0.21.0-rc.6/worker";

const worker = createWorker(
  {
    id: "image-worker",
    transport: {
      type: "in-process",
      config: { topic: "images" },
    },
    workloads: {
      "image.resize": resize,
    },
    capacity: 4,
  },
  {
    onWorkAccepted,
    onStart,
    onComplete,
  },
);

await worker.ready;
await worker.closed;
```

`createWorker(options, callbacks)` starts immediately. `WorkerOptions` contains
one visible `transport`, named workload handlers, capacity/cancellation,
functional activation/registration/handshake operations, heartbeat metadata,
reconnect policy, and bounded timing/stream options.

The returned `Worker` exposes `ready`, `closed`, lifecycle `events`, `stop()`,
and `snapshot()`—no separate start choreography.

## Workloads

A `WorkerWorkHandler` receives `WorkerWorkContext` with stream/workload IDs,
immutable metadata, credited `input`, cancellation `signal`, and
`sendMetadata()`.

Worker lifecycle contexts expose the protocol `streamId`. The application-level
Hypervisor `operationId` is intentionally absent because worker protocol v1 does
not transmit it; applications can place their own durable identifier in metadata
when both sides require it.

It returns `WorkerWorkResult`: nothing, a `WorkerBody`, or an object with
metadata and body. `WorkerBody` is `Uint8Array | ReadableStream<Uint8Array>`.
Large content remains streamed and binary.

The Worker reserves capacity before acceptance. `onWorkAccepted` precedes the
ACK; `onStart` precedes handler invocation after a validated Start; completion
and output cancellation settle before capacity is released.

## State and results

`WorkerSnapshot` contains `WorkerState`, physical transport type, full identity,
credential/handshake state, connection ID, active streams, occupied process
executions, and reconnect attempt. `WorkerResult` distinguishes normal
shutdown/stop, re-enrollment, and reconnect exhaustion.

`WorkerError` uses `WorkerErrorCode` for connection, credential, handshake,
initialization, protocol, reconnect, and explicit-stop failures.

## Reconnect

A `WorkerReconnectDelay` receives `WorkerReconnectContext`. Use
`createBoundedExponentialBackoff(options)` with
`BoundedExponentialBackoffOptions` for bounded exponential delay and optional
jitter/attempt limits.

Process-lifetime reservations survive a lost session until the handler/output
source actually settles. This prevents replacement sessions from exceeding
capacity.

## Credential and readiness contexts

`WorkerResumeCredentialUpdate` is the atomic rotation record. The lower-level
`WorkerResumeCredentialPersister` persists it with compare-and-set semantics.
`WorkerBeforeReadyContext` carries bootstrap and connection state;
`WorkerHeartbeatContext` carries a frozen capacity/status snapshot.

WebSocket-specific queue/backpressure bounds use `WorkerWebSocketLimits`.
Lifecycle operation/callback types such as `WorkerActivate`, `WorkerRegister`,
`WorkerHandshake`, and `WorkerLifecycleCallbacks` are exported from the package
root.

See the full [Worker guide](../workers.md).
