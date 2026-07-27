# Oxian worker protocol v1

This document is the normative wire contract for `oxian.worker.v1`. Package
versions may change without changing this protocol identifier.

## Transport and framing

A worker connects outbound to the Hypervisor over WSS and offers the exact
`Sec-WebSocket-Protocol` value `oxian.worker.v1`. Native workers never expose an
HTTP listener. HTTPS endpoints may enroll, revoke, or inspect workers, but work
travels over the authenticated WebSocket.

Control frames are UTF-8 JSON WebSocket text messages. Bulk data uses binary
WebSocket messages with the 28-byte `OXNB` header implemented by
`src/protocol/binary.ts`; data is never base64-encoded.

The v1 hard limits are:

| Resource                                |        Limit |
| --------------------------------------- | -----------: |
| Control frame                           | 64 KiB UTF-8 |
| Binary data payload                     |        1 MiB |
| Outstanding credit per stream direction |       16 MiB |
| Stream IDs used during one connection   |       65,536 |
| Declared worker capacity                |        1,024 |

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
   from overwriting a later rotation. Durable persistence is the client default;
   a process-lifetime worker must explicitly opt into ephemeral resume state.
4. The worker applies optional bootstrap through its workload-owned pre-ready
   hook and sends `ready`, echoing connection ID and capacity plus bounded
   workload-owned result metadata. Bootstrap failure never advertises the worker
   as ready and reconnects with the newly persisted resume credential. Generic
   core does not interpret snapshots, revisions, checkpoints, or process
   summaries in either opaque object. Bootstrap attempts across reconnects are
   sequential and must be idempotent.
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

After receiving `drain`, the worker stops accepting work, settles active
streams, sends `drained`, and remains connected. A gateway performing proactive
connection rotation closes that drained socket without `shutdown`; an
indefinitely running worker reconnects with its persisted resume credential.
Terminal operator or provider shutdown is instead an explicit `shutdown` frame,
after which the worker stops and does not reconnect.

Only an authenticated current session may become ready. Connection ID checks in
the wire state machine do not replace registry fencing: before processing every
inbound frame, the gateway must synchronously confirm that its socket still owns
the current authority-issued session generation and
`(workerId, attemptId, epoch, connectionId)` record. Replaced sockets are closed
and their later frames are ignored.

## Work lifecycle and acceptance boundary

The Hypervisor creates a unique lowercase UUID stream ID and sends `work.open`
for a workload declared in `hello`.

Work authorization is deliberately two-phase:

1. The worker reserves capacity and replies `work.accepted`. It must not invoke
   workload code, expose the body to a handler, or perform side effects yet.
2. The Hypervisor observes the claim and durably commits the operation's
   acceptance. That successful commit is the no-replay boundary.
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

Control-frame direction is:

| Frame                                                                      | Sender                    |
| -------------------------------------------------------------------------- | ------------------------- |
| `hello`, `ready`, `heartbeat`, `drained`, `work.accepted`, `work.metadata` | Worker                    |
| `welcome`, `ready_ack`, `drain`, `shutdown`, `work.open`, `work.start`     | Hypervisor                |
| `protocol_error`, `work.credit`, `work.end`, `work.cancel`, `work.error`   | Either                    |
| `work.data`                                                                | Either, as a binary frame |

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
worker sends exactly one `work.metadata` response frame before its first data
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
ends. Tombstones do not consume worker capacity or block `drained`. A late
End-to-Cancel/Error upgrade is accepted once and discarded from workload code;
the peer reciprocates with Cancel/Error even though its live application stream
is already gone. Abort/Abort then retires the tombstone. Retention is bounded by
the per-connection lifetime stream limit.

WebSocket ordering is not shared across directions. A frame sent before a peer
observed cancel/error can arrive after the local terminal frame. The validator
therefore accepts and validates crossed inbound frames but returns disposition
`discard`; workload code must not receive them. A crossed `work.accepted` is
always delivered to the Hypervisor so it can process the worker's claim. A
crossed `work.start` after the worker locally aborted is recorded but discarded,
so it never invokes the workload. Once a terminal frame has arrived from a
direction, later data, metadata, or another normal end from that same direction
are violations. The only terminal exception is the one-way End-to-Cancel/Error
upgrade above. Credit is about the opposite data half, so a peer that normally
ended its own half may still grant credit to the other live half; no credit may
follow cancel/error. Credit granted before observing the opposite End may cross
that End and arrive after the receiver has reached End/End; the receiver
validates and discards that inbound credit from its terminal tombstone. Locally
sending new credit after observing End/End remains a protocol violation.

## Disconnect settlement

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
