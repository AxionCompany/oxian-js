# Oxian worker protocol v1

This document is the normative wire contract for `oxian.worker.v1`. Package
versions may change without changing this protocol identifier.

## Transport and framing

A Worker connects outward to the Hypervisor. Across a process boundary it uses
WSS and offers the exact `Sec-WebSocket-Protocol` value `oxian.worker.v1`;
Workers never expose an HTTP listener. In one module realm, the built-in local
transport carries the unchanged encoded frames through an addressed event fabric
and executes this same state machine.

Control frames are canonical UTF-8 JSON strings. Bulk data uses binary frames
with the 28-byte `OXNB` header implemented by `src/protocol/binary.ts`; data is
never base64-encoded.

The v1 hard limits are:

| Resource                                |        Limit |
| --------------------------------------- | -----------: |
| Control frame                           | 64 KiB UTF-8 |
| Binary data payload                     |        1 MiB |
| Outstanding credit per stream direction |       16 MiB |
| Stream IDs used during one connection   |       65,536 |
| Declared worker capacity                |        1,024 |
| Negotiated reverse-call capacity        |        1,024 |

An implementation may admit less than a hard limit, but it must never emit or
accept a value above the v1 maximum. Reaching the lifetime stream limit requires
a fresh connection; used stream IDs are never reused on one connection.

## Connection handshake

1. The worker sends `hello` first. It includes a fresh handshake ID, logical
   worker ID, provisioned Control-plane attempt ID, fencing epoch, a
   registration or resume capability, declared workloads, and capacity. The
   attempt ID stays stable across process restarts until Control provisions a
   new attempt. If the socket is lost before `welcome`, the worker retries the
   same credential and handshake ID so the authority can replay that exact
   exchange without consuming another one-time capability.
2. The Hypervisor authenticates and fences the identity, then sends `welcome`
   with a new connection ID, heartbeat interval, lease timeout, rotated resume
   capability, its expiry timestamp, and bounded workload-owned bootstrap
   metadata, but no work. Welcome makes the rotated capability a candidate and
   the worker generates a fresh handshake ID for it.
3. The worker durably persists the candidate capability and handshake ID
   together, then adopts them. Explicit persistence failure leaves the prior
   credential and handshake ID current so the exact exchange can be replayed. An
   exact Welcome replay reuses the same pending candidate and generated
   handshake ID. Durable writes must be atomic, idempotent for that update, and
   compare-and-set the candidate's predecessor handshake ID. The persistence
   Promise resolves only after durable commit. This prevents a late completion
   from overwriting a later rotation. Remote production Workers persist through
   their functional `handshake` operation; private local defaults retain only
   process-lifetime resume state.
4. The worker applies optional bootstrap through its workload-owned pre-ready
   hook and sends `ready`, echoing connection ID and capacity plus bounded
   workload-owned result metadata. Bootstrap failure never advertises the worker
   as ready and reconnects with the newly persisted resume credential. Generic
   core does not interpret snapshots, revisions, checkpoints, or process
   summaries in either opaque object. The one reserved transport capability
   below is stripped before application delivery. Bootstrap attempts across
   reconnects are sequential and must be idempotent.
5. The Hypervisor durably commits and publishes the Ready transition, then sends
   `ready_ack`. `ready_ack` is authoritative: only after receiving it may the
   worker resolve its readiness promise, begin heartbeats, or accept work. If
   the socket closes before the acknowledgement, the worker remains unready and
   reconnects with its persisted resume credential.
6. The worker sends contiguous heartbeats beginning at sequence zero. Every
   heartbeat carries a bounded workload-owned JSON metadata object (`{}` when
   unused) alongside the generic inflight and available-capacity counters.
   Generic core validates and transports this object but does not interpret it.

The process-local session registry publishes the authority-issued generation
only when Ready is accepted. Same-generation replay is therefore valid only
before that first attachment, for a lost Welcome. Once a generation has been
published, its high-watermark survives detach and lease expiry; reconnecting
workers must exchange the durably adopted resume capability for a strictly newer
generation.

The persistence and pre-ready `AbortSignal`s are advisory. A timeout, socket
loss, or stop cannot cancel an arbitrary JavaScript Promise. The worker never
opens another connection or starts another persistence/bootstrap operation while
the prior operation remains unresolved. Once it actually settles, a running
worker may reconnect and retry sequentially; `stop()` may finish without waiting
for that underlying operation.

After receiving `drain`, the worker stops accepting new forward work, settles
active streams, sends `drained`, and remains connected. A gateway performing
proactive connection rotation closes that drained socket without `shutdown`; an
indefinitely running worker reconnects with its persisted resume credential.
Terminal operator or provider shutdown is instead an explicit `shutdown` frame,
after which the worker stops and does not reconnect.

Only an authenticated current session may become ready. Connection ID checks in
the wire state machine do not replace registry fencing: before processing every
inbound frame, the gateway must synchronously confirm that its socket still owns
the current authority-issued session generation and
`(workerId, attemptId, epoch, connectionId)` record. Replaced sockets are closed
and their later frames are ignored.

## Optional worker-to-host invocation

The extension is enabled by host admission policy and retains the `oxian.worker.v1` protocol identifier.
It uses the reserved transport key `__oxian_worker_calls_v1`, whose value is
`{ "version": 1, "capacity": N, "maxLifetimeStreams": L }`, with a positive
safe-integer `N` no greater than 1,024 and `L` from 1 through 65,536. The lifetime
field is optional and defaults to 65,536 when omitted:

1. The host offers the capability in `Welcome.bootstrap`.
2. Supporting workers automatically acknowledge it in `Ready.metadata`, with
   capacity and lifetime no greater than the offer or local limits. Absence of an acknowledgement disables reverse invocation.
3. A malformed capability, an acknowledgement without an offer, or a capacity
   or lifetime above the offer is a protocol violation. It never falls back to enabling
   calls with inferred values.
4. The negotiated capacity activates only at `ready_ack`.

An old host sends no offer; an old worker sends no acknowledgement. Either
combination remains ordinary-only. Without negotiation, the original strict
frame directions below still apply. Applications must not use the reserved key
in bootstrap or Ready metadata; runtime callbacks receive those objects with
only the transport capability stripped.

On a negotiated connection a worker may initiate `work.open` with a fresh UUID
and host workload name. That workload need not appear in the worker's `hello`
workloads. The optional `parentStreamId` is a lowercase UUID and is valid only
on worker-originated Open. The protocol validates its shape; the host runtime
must resolve it to that connection's current, started assignment before
admitting the call, and recheck the binding before handler entry. No parent
identity supplied in metadata replaces that check. Parentless calls require a
separate application admission policy and are denied by default.

For each stream the opening peer is the initiator: it sends Open and Start; the
responder sends Accepted and Metadata. Other work frames retain their existing
bidirectional behavior. For a reverse call:

1. The host reserves bounded admission and returns `work.accepted`, without
   invoking the effectful handler.
2. The worker marks the call potentially executable before attempting to send
   `work.start`. Even a failed send can have physically delivered Start.
3. The host invokes its authorized handler only after delivered Start, while its
   session/parent binding and deadline remain valid.

Reverse streams consume their negotiated capacity independently of forward
Worker capacity. Both directions share one stream-ID namespace, strict no-reuse
rule, and negotiated total connection lifetime (at most 65,536). To make
simultaneous Opens safe, the host owns ceil(L / 2) lifetime slots and the worker
owns floor(L / 2); neither may borrow unused slots from the other. Local queued
Opens reserve slots before emission. Either exhausted share triggers host-driven
rotation, while the other remains available to existing assignments during
drain. Worker exhaustion refuses locally with `capacity/not_started`.
Unnegotiated connections keep the full forward budget. Existing sequence,
byte-credit, response-metadata ordering, terminal, and tombstone rules apply
unchanged.

During drain, new forward opens and parentless reverse opens are rejected.
Parent-bound reverse calls may continue while their authenticated parent is
active, so draining an execution does not prevent its dependent host calls.
Drained remains invalid while streams in either direction are active.
Application admission, handler, and source-cleanup limits survive session
replacement until those activities actually settle; a timeout signal cannot
force an arbitrary promise to stop.

This extension does not provide a durable owner, acceptance transaction, or
receipt store. Reverse failures before Start can be sent are `not_started`;
failures once Start can have been sent are `indeterminate`. Neither reverse
calls nor their byte streams are automatically replayed after reconnect.
Applications recover durable receipts or reconcile effects under their own
logical identity and authority rules. Normal stream completion does not prove
application commit. See the [runtime call guide](worker-host-calls.md).

## Work lifecycle and acceptance boundary

For ordinary forward work, the Hypervisor creates a unique lowercase UUID stream
ID and sends `work.open` for a workload declared in `hello`. The durable
acceptance callback described here applies to that forward dispatch path.

A Hypervisor may queue bounded, unoffered intent before reserving a session.
Such entries have no stream ID on wire and can expire or be cancelled locally.
This scheduling policy adds no frames and never automatically replays work once
it enters the offer/acceptance lifecycle.

Work authorization is deliberately two-phase:

1. The worker reserves capacity and replies `work.accepted`. It must not invoke
   workload code, expose the body to a handler, or perform side effects yet.
2. The Hypervisor observes the claim and awaits its `onWorkAccepted` durable
   acceptance callback. That successful commit is the no-replay boundary.
3. Only then does the Hypervisor send `work.start`.
4. The worker invokes the workload only when a delivered `work.start` is
   accepted by its connection state machine.

`work.metadata`, `work.data`, `work.credit`, and normal `work.end` are invalid
before `work.start`. Either peer may send `work.cancel` or `work.error` before
start to reject or abandon the reservation.

A worker that receives a racing `work.open` while entering a local credential
rotation rejects it before acceptance with
`work.cancel.reason =
"worker_draining"`. Because no `work.accepted` boundary
was crossed, the Hypervisor treats that stable reason as retryable on another
ready connection.

For normal completion and handler failure, the Worker settles its output source
and completion hook, then releases its execution slot before sending the
terminal. The Hypervisor may reuse its reservation upon receiving that terminal.
Early cancellation acknowledgements do not certify execution settlement: a
handler that ignores cancellation keeps its process-lifetime slot, including
across reconnect. `worker_capacity` rejects Open before `work.accepted`; it is
not evidence that any accepted operation is safe to replay.

Without reverse negotiation, control-frame direction is:

| Frame                                                                      | Sender                    |
| -------------------------------------------------------------------------- | ------------------------- |
| `hello`, `ready`, `heartbeat`, `drained`, `work.accepted`, `work.metadata` | Worker                    |
| `welcome`, `ready_ack`, `drain`, `shutdown`, `work.open`, `work.start`     | Hypervisor                |
| `protocol_error`, `work.credit`, `work.end`, `work.cancel`, `work.error`   | Either                    |
| `work.data`                                                                | Either, as a binary frame |

With negotiation, the four stream-opening/response frame directions are checked
against that stream's initiator and responder as described above; connection
lifecycle directions do not change.

## Data, sequence, and credit

Each stream has independent send and receive sequences. The first `work.data`
frame in each direction has sequence zero and every subsequent frame increments
it by one. Gaps, duplicates, malformed objects, empty payloads, and frames above
the fixed payload limit are protocol violations.

A receiver grants byte credit with `work.credit`; a sender must consume that
credit before emitting data. Credit applies to the opposite data direction.
Outstanding credit may not exceed the fixed v1 window. Web Streams adapters must
stop pulling producers when credit is exhausted so the wire window provides
end-to-end backpressure.

`work.open.metadata` is the initiator's request metadata. After start, the
responder sends exactly one `work.metadata` response frame before its first data
frame or normal end; `{}` is valid. Progress and repeated events belong in the
credited byte stream or workload schema, so metadata is not an uncredited event
channel.

## Directional termination and races

`work.end`, `work.cancel`, and `work.error` terminate only the sender's stream
half for ordering purposes:

- `work.end` is a normal half-close; the opposite direction may continue.
- `work.cancel` and `work.error` request whole-operation abort.
- Until the peer half also terminates, a sender may upgrade its prior normal
  `work.end` to one `work.cancel` or `work.error`. This is required when, for
  example, request upload completed but the response consumer is later
  abandoned. An abort terminal is final: it cannot be repeated or downgraded
  back to `work.end`.
- A peer receiving cancel/error aborts local workload activity and, if its own
  half is open or normally ended, replies with `work.cancel` or `work.error`; a
  prior End is upgraded.
- A stream closes only as End/End or Abort/Abort. Mixed End/Abort remains active
  and consumes capacity until the End side upgrades to Cancel/Error. `drained`
  is invalid while any such stream remains.

Because the two directions can cross, each endpoint retains bounded terminal
ordering tombstones for normally closed End/End streams until the connection
ends. Tombstones do not consume forward or reverse capacity or block `drained`.
A late End-to-Cancel/Error upgrade is accepted once and discarded from workload
code; the peer reciprocates with Cancel/Error even though its live application
stream is already gone. Abort/Abort then retires the tombstone. Retention is
bounded by the per-connection lifetime stream limit.

WebSocket ordering is not shared across directions. A frame sent before a peer
observed cancel/error can arrive after the local terminal frame. The validator
therefore accepts and validates crossed inbound frames but returns disposition
`discard`; workload code must not receive them. A crossed `work.accepted` is
always delivered to the initiator so it can process the responder's claim. A
crossed `work.start` after the responder locally aborted is recorded but
discarded, so it never invokes the workload. Once a terminal frame has arrived
from a direction, later data, metadata, or another normal end from that same
direction are violations. The only terminal exception is the one-way
End-to-Cancel/Error upgrade above. Credit is about the opposite data half, so a
peer that normally ended its own half may still grant credit to the other live
half; no credit may follow cancel/error. Credit granted before observing the
opposite End may cross that End and arrive after the receiver has reached
End/End; the receiver validates and discards that inbound credit from its
terminal tombstone. Locally sending new credit after observing End/End remains a
protocol violation.

## Disconnect settlement

For ordinary forward dispatch:

- If the connection is lost before the Hypervisor durably commits acceptance,
  the worker cannot have received `work.start` and therefore cannot have invoked
  the workload. Retry with a new stream is safe, even if an uncommitted
  `work.accepted` had arrived.
- Once the Hypervisor durably commits acceptance, the operation is
  non-replayable. Loss before or after delivery of `work.start` is
  indeterminate.
- Accepted streams are never resumed or replayed automatically after reconnect.
  A workload may define a separate durable-resumption capability, but it is not
  part of the generic worker lifecycle.

Protocol violations carry stable machine-readable codes. The gateway sends a
bounded `protocol_error` when possible, closes the offending socket, and never
uses attacker-controlled error text as a WebSocket close reason.
