# `jsr:@oxian/oxian-js@0.21.0-rc.4/protocol`

[Back to the API reference](../api-reference.md)

The `/protocol` subpath is the complete public wire contract for
`oxian.worker.v1`: JSON control frames, binary data frames, hard limits, byte
credit, connection and stream ordering, snapshots, and classifiable protocol
violations.

```ts
import {
  createHelloFrame,
  createProtocolOrderValidator,
  decodeBinaryFrame,
  parseControlFrame,
  WORKER_PROTOCOL,
} from "jsr:@oxian/oxian-js@0.21.0-rc.4/protocol";
```

The package version and protocol version evolve independently. Oxian 0.21 speaks
`oxian.worker.v1`; a later 0.20 patch can remain wire-compatible without
changing that identifier.

## Export summary

### Values

| Area                | Exports                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Constants           | `WORKER_PROTOCOL`, `WORKER_PROTOCOL_LIMITS`, `BINARY_PROTOCOL`                                                                                                                                           |
| Control codecs      | `decodeControlFrame`, `parseControlFrame`, `encodeControlFrame`                                                                                                                                          |
| Identity            | `createWorkerIdentity`                                                                                                                                                                                   |
| Handshake factories | `createHelloFrame`, `createWelcomeFrame`, `createReadyFrame`, `createReadyAckFrame`, `createHeartbeatFrame`, `createDrainFrame`, `createShutdownFrame`, `createDrainedFrame`, `createProtocolErrorFrame` |
| Work factories      | `createWorkOpenFrame`, `createWorkAcceptedFrame`, `createWorkStartFrame`, `createWorkMetadataFrame`, `createWorkEndFrame`, `createWorkCancelFrame`, `createWorkErrorFrame`, `createWorkCreditFrame`      |
| Binary data         | `createStreamId`, `validateWorkDataFrame`, `createWorkDataFrame`, `encodeBinaryFrame`, `decodeBinaryFrame`                                                                                               |
| Credit              | `createCreditWindow`                                                                                                                                                                                     |
| Ordering            | `createProtocolOrderValidator`                                                                                                                                                                           |
| Violations          | `createProtocolViolation`, `isProtocolViolation`, `throwProtocolViolation`                                                                                                                               |

### Types

| Area              | Exports                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON and identity | `WorkerProtocol`, `JsonPrimitive`, `JsonValue`, `JsonObject`, `WorkerIdentity`, `WorkerCredential`                                                                                              |
| Handshake frames  | `HelloFrame`, `WelcomeFrame`, `ReadyFrame`, `ReadyAckFrame`, `HeartbeatFrame`, `DrainFrame`, `ShutdownFrame`, `DrainedFrame`, `ProtocolErrorFrame`                                              |
| Work frames       | `WorkOpenFrame`, `WorkAcceptedFrame`, `WorkStartFrame`, `WorkMetadataFrame`, `WorkEndFrame`, `WorkCancelFrame`, `WorkErrorFrame`, `WorkCreditFrame`, `WorkDataFrame`                            |
| Frame unions      | `ControlFrame`, `ControlFrameType`, `WorkerToHypervisorControlFrame`, `HypervisorToWorkerControlFrame`                                                                                          |
| Codecs and limits | `ControlFrameCodecOptions`, `BinaryFrameOptions`, `BinaryProtocol`, `WorkerProtocolLimits`                                                                                                      |
| Credit            | `CreditWindowOptions`, `CreditWindowSnapshot`, `CreditWindow`                                                                                                                                   |
| Ordering          | `ProtocolRole`, `ProtocolDirection`, `ProtocolFrameDisposition`, `ProtocolPhase`, `ProtocolFrameAcceptance`, `ProtocolOrderValidatorOptions`, `ProtocolOrderValidator`, `ProtocolStateSnapshot` |
| Stream state      | `WorkStreamTerminal`, `WorkStreamStatus`, `WorkStreamSnapshot`                                                                                                                                  |
| Violations        | `ProtocolViolationCode`, `ProtocolViolation`                                                                                                                                                    |

## Protocol identifier and hard limits

```ts
const WORKER_PROTOCOL = "oxian.worker.v1" as const;
type WorkerProtocol = typeof WORKER_PROTOCOL;

type WorkerProtocolLimits = Readonly<{
  maxControlFrameBytes: number;
  maxDataPayloadBytes: number;
  maxOutstandingStreamCreditBytes: number;
  maxLifetimeStreams: number;
  maxWorkerCapacity: number;
}>;

const WORKER_PROTOCOL_LIMITS: WorkerProtocolLimits;
```

The exported limits are frozen interoperability bounds:

| Resource                                | Limit        |
| --------------------------------------- | ------------ |
| Control frame                           | 64 KiB UTF-8 |
| Binary data payload                     | 1 MiB        |
| Outstanding credit per stream direction | 16 MiB       |
| Stream IDs during one connection        | 65,536       |
| Declared worker capacity                | 1,024        |

Connection-local configuration may admit less but can never raise a v1 hard
limit. Used stream IDs are not reusable on the same connection; reaching the
lifetime bound requires reconnecting.

## JSON, identity, and credentials

```ts
type JsonPrimitive = boolean | number | string | null;

type JsonValue =
  | JsonPrimitive
  | JsonObject
  | readonly JsonValue[];

type JsonObject = {
  readonly [key: string]: JsonValue;
};

type WorkerIdentity = Readonly<{
  workerId: string;
  attemptId: string;
  epoch: number;
}>;

type WorkerCredential =
  | Readonly<{
    kind: "registration";
    capability: string;
  }>
  | Readonly<{
    kind: "resume";
    capability: string;
  }>;
```

`workerId` identifies the logical worker. `attemptId` is one provisioned
Control-plane attempt and remains stable across its process restarts. `epoch`
monotonically fences older attempts. Connection ID and session generation add
further session-level fencing above this identity.

Identifiers are 1–128 characters, begin with an ASCII alphanumeric character,
and then contain only letters, digits, `.`, `_`, `:`, or `-`. Workload names
also permit `/`. Capabilities are non-empty and at most 16,384 characters.

```ts
function createWorkerIdentity(input: WorkerIdentity): WorkerIdentity;
```

Validates and returns a fresh identity value. Epoch must be a non-negative safe
integer.

Control-frame JSON is copied during validation. Numbers must be finite, objects
must be plain, symbol keys and cycles are rejected, and nesting is limited to 32
levels.

## Control frame contracts

Every control frame carries the exact `protocol: "oxian.worker.v1"` value and
travels as one UTF-8 JSON WebSocket text message.

### Handshake and lifecycle frames

```ts
type HelloFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "hello";
  handshakeId: string;
  identity: WorkerIdentity;
  credential: WorkerCredential;
  workloads: readonly string[];
  capacity: number;
}>;

type WelcomeFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "welcome";
  connectionId: string;
  heartbeatIntervalMs: number;
  leaseTimeoutMs: number;
  resumeCapability: string;
  resumeExpiresAtMs: number;
  bootstrap: JsonObject;
}>;

type ReadyFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "ready";
  connectionId: string;
  capacity: number;
  metadata: JsonObject;
}>;

type ReadyAckFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "ready_ack";
  connectionId: string;
}>;

type HeartbeatFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "heartbeat";
  connectionId: string;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  metadata: JsonObject;
}>;

type DrainFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "drain";
  connectionId: string;
  reason: string;
  deadlineAtMs: number;
}>;

type ShutdownFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "shutdown";
  connectionId: string;
  reason: string;
}>;

type DrainedFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "drained";
  connectionId: string;
}>;

type ProtocolErrorFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "protocol_error";
  connectionId?: string;
  code: string;
  message: string;
}>;
```

`workloads` is non-empty, unique, and contains valid workload IDs. Capacity is
1–1,024. Heartbeat sequence is an unsigned 32-bit integer and load counters are
0–1,024. A Welcome lease timeout must be strictly greater than its heartbeat
interval. Expiries and deadlines are non-negative safe-integer absolute
timestamps.

Reasons are non-empty and at most 2,048 characters. Error codes use the
identifier format; error messages are non-empty and at most 16,384 characters.
`ProtocolErrorFrame.connectionId` is absent only before a connection ID has been
established.

### Work control frames

```ts
type WorkOpenFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.open";
  streamId: string;
  workload: string;
  metadata: JsonObject;
  deadlineAtMs?: number;
}>;

type WorkAcceptedFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.accepted";
  streamId: string;
}>;

type WorkStartFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.start";
  streamId: string;
}>;

type WorkMetadataFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.metadata";
  streamId: string;
  metadata: JsonObject;
}>;

type WorkEndFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.end";
  streamId: string;
}>;

type WorkCancelFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.cancel";
  streamId: string;
  reason: string;
}>;

type WorkErrorFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.error";
  streamId: string;
  code: string;
  message: string;
  details?: JsonObject;
}>;

type WorkCreditFrame = Readonly<{
  protocol: WorkerProtocol;
  type: "work.credit";
  streamId: string;
  bytes: number;
}>;
```

Stream IDs are lowercase UUID strings. Credit is a positive safe integer no
greater than 16 MiB per grant. Optional deadlines are non-negative safe
integers. Work error fields use the same code and message rules as protocol
errors.

`work.open.metadata` is request metadata. After Start, the worker sends exactly
one `work.metadata` response before its first data frame or normal End. Repeated
progress belongs in the credited byte stream, not uncredited metadata frames.

### Frame unions and direction

```ts
type ControlFrame =
  | HelloFrame
  | WelcomeFrame
  | ReadyFrame
  | ReadyAckFrame
  | HeartbeatFrame
  | DrainFrame
  | ShutdownFrame
  | DrainedFrame
  | ProtocolErrorFrame
  | WorkOpenFrame
  | WorkAcceptedFrame
  | WorkStartFrame
  | WorkMetadataFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;

type ControlFrameType = ControlFrame["type"];

type WorkerToHypervisorControlFrame =
  | HelloFrame
  | ReadyFrame
  | HeartbeatFrame
  | DrainedFrame
  | ProtocolErrorFrame
  | WorkAcceptedFrame
  | WorkMetadataFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;

type HypervisorToWorkerControlFrame =
  | WelcomeFrame
  | ReadyAckFrame
  | DrainFrame
  | ShutdownFrame
  | ProtocolErrorFrame
  | WorkOpenFrame
  | WorkStartFrame
  | WorkEndFrame
  | WorkCancelFrame
  | WorkErrorFrame
  | WorkCreditFrame;
```

The two directional unions overlap for frames either peer may send:
`protocol_error`, `work.credit`, `work.end`, `work.cancel`, and `work.error`.
Binary `work.data` is also bidirectional.

## Control codecs

```ts
type ControlFrameCodecOptions = Readonly<{
  maxFrameBytes?: number;
}>;

function decodeControlFrame(value: unknown): ControlFrame;

function parseControlFrame(
  text: string,
  options?: ControlFrameCodecOptions,
): ControlFrame;

function encodeControlFrame(
  frame: ControlFrame,
  options?: ControlFrameCodecOptions,
): string;
```

`maxFrameBytes` defaults to 64 KiB, must be a positive safe integer, and cannot
exceed the v1 hard limit.

`decodeControlFrame` accepts an already decoded value. It requires a plain
object, the exact fields for its discriminant, valid nested JSON, and the exact
protocol. Unknown or missing fields are violations. It returns a fresh object,
so later caller mutation of the input cannot alter the validated frame.

`parseControlFrame` enforces the UTF-8 byte limit before `JSON.parse`, then uses
the strict decoder. `encodeControlFrame` also passes outbound typed values
through the decoder before serializing and enforces the encoded byte limit. A
type assertion therefore cannot make an invalid frame cross this boundary.

Failures throw `ProtocolViolation`. An option above the hard limit throws a
plain `TypeError`.

## Control frame factories

For the following matrix, `Fields<T>` means `Omit<T, "protocol" | "type">`.
Every factory injects the exact protocol and type, runs the same strict decoder,
copies JSON values, and returns the named frame.

| Factory                    | Input                                                                  | Defaulted field |
| -------------------------- | ---------------------------------------------------------------------- | --------------- |
| `createHelloFrame`         | `Fields<HelloFrame>`                                                   | none            |
| `createWelcomeFrame`       | `Omit<Fields<WelcomeFrame>, "bootstrap"> & { bootstrap?: JsonObject }` | `bootstrap: {}` |
| `createReadyFrame`         | `Omit<Fields<ReadyFrame>, "metadata"> & { metadata?: JsonObject }`     | `metadata: {}`  |
| `createReadyAckFrame`      | `Fields<ReadyAckFrame>`                                                | none            |
| `createHeartbeatFrame`     | `Omit<Fields<HeartbeatFrame>, "metadata"> & { metadata?: JsonObject }` | `metadata: {}`  |
| `createDrainFrame`         | `Fields<DrainFrame>`                                                   | none            |
| `createShutdownFrame`      | `Fields<ShutdownFrame>`                                                | none            |
| `createDrainedFrame`       | `Fields<DrainedFrame>`                                                 | none            |
| `createProtocolErrorFrame` | `Fields<ProtocolErrorFrame>`                                           | none            |
| `createWorkOpenFrame`      | `Fields<WorkOpenFrame>`                                                | none            |
| `createWorkAcceptedFrame`  | `Fields<WorkAcceptedFrame>`                                            | none            |
| `createWorkStartFrame`     | `Fields<WorkStartFrame>`                                               | none            |
| `createWorkMetadataFrame`  | `Fields<WorkMetadataFrame>`                                            | none            |
| `createWorkEndFrame`       | `Fields<WorkEndFrame>`                                                 | none            |
| `createWorkCancelFrame`    | `Fields<WorkCancelFrame>`                                              | none            |
| `createWorkErrorFrame`     | `Fields<WorkErrorFrame>`                                               | none            |
| `createWorkCreditFrame`    | `Fields<WorkCreditFrame>`                                              | none            |

Representative signatures:

```ts
function createHelloFrame(
  input: Omit<HelloFrame, "protocol" | "type">,
): HelloFrame;

function createWorkErrorFrame(
  input: Omit<WorkErrorFrame, "protocol" | "type">,
): WorkErrorFrame;
```

## Binary work data

### Contract and constants

```ts
type WorkDataFrame = Readonly<{
  type: "work.data";
  streamId: string;
  sequence: number;
  payload: Uint8Array;
}>;

type BinaryFrameOptions = Readonly<{
  maxPayloadBytes?: number;
}>;

type BinaryProtocol = Readonly<{
  version: number;
  headerBytes: number;
  workDataType: number;
  maxPayloadBytes: number;
}>;

const BINARY_PROTOCOL: BinaryProtocol;
```

`BINARY_PROTOCOL` is frozen with version `1`, header size `28`, work-data type
`1`, and maximum payload `1 MiB`.

The fixed binary header is:

| Bytes     | Meaning                              |
| --------- | ------------------------------------ |
| 0–3       | ASCII `OXNB` magic                   |
| 4         | binary version, `1`                  |
| 5         | frame type, `1` for `work.data`      |
| 6–7       | reserved zero bytes                  |
| 8–23      | 16-byte UUID stream ID               |
| 24–27     | unsigned 32-bit sequence, big endian |
| 28 onward | non-empty opaque payload             |

### Binary functions

```ts
function createStreamId(): string;

function validateWorkDataFrame(
  value: unknown,
  options?: BinaryFrameOptions,
): WorkDataFrame;

function createWorkDataFrame(
  input: Omit<WorkDataFrame, "type">,
  options?: BinaryFrameOptions,
): WorkDataFrame;

function encodeBinaryFrame(
  input: WorkDataFrame,
  options?: BinaryFrameOptions,
): Uint8Array;

function decodeBinaryFrame(
  input: ArrayBuffer | Uint8Array,
  options?: BinaryFrameOptions,
): WorkDataFrame;
```

`createStreamId()` delegates to `crypto.randomUUID()`.

`maxPayloadBytes` defaults to 1 MiB, must be a positive safe integer, and cannot
exceed the v1 bound. Stream IDs must be lowercase UUIDs, sequences are integers
from zero through `4_294_967_295`, and payloads must be non-empty `Uint8Array`
values within the effective bound.

`validateWorkDataFrame` requires exactly `type`, `streamId`, `sequence`, and
`payload`; it does not copy the payload. `createWorkDataFrame` accepts the three
non-type fields and owns a copy of the caller's payload. `encodeBinaryFrame`
returns a new header-plus-payload array. `decodeBinaryFrame` respects a
`Uint8Array` view's offset and returns a payload copy detached from the input
buffer.

Malformed frames throw `ProtocolViolation`, commonly `invalid_binary_frame`,
`unsupported_protocol`, `unsupported_frame_type`, or `data_payload_too_large`.

## Byte-credit window

```ts
type CreditWindowOptions = Readonly<{
  initialCredit?: number;
  maxCredit?: number;
}>;

type CreditWindowSnapshot = Readonly<{
  available: number;
  granted: number;
  consumed: number;
  maxCredit: number;
}>;

type CreditWindow = Readonly<{
  available(): number;
  canConsume(bytes: number): boolean;
  consume(bytes: number): number;
  grant(bytes: number): number;
  snapshot(): CreditWindowSnapshot;
  tryConsume(bytes: number): boolean;
}>;

function createCreditWindow(
  options?: CreditWindowOptions,
): CreditWindow;
```

This deterministic primitive contains no wait queue. Receivers call `grant`;
senders call `consume` before emitting data. Transports decide how to suspend a
producer when credit is unavailable.

Initial credit defaults to zero and maximum credit to `Number.MAX_SAFE_INTEGER`.
Both are safe integers; initial credit may be zero and cannot exceed the
positive maximum.

- `available()` returns the current credit.
- `canConsume(bytes)` validates a non-negative amount without mutation.
- `tryConsume(bytes)` consumes and counts the amount when available, returning
  `false` without mutation otherwise.
- `consume(bytes)` returns remaining credit or throws `RangeError` when
  insufficient.
- `grant(bytes)` requires a positive amount, returns available credit, and
  throws `RangeError` rather than exceeding the maximum.
- `snapshot()` reports current credit plus cumulative granted and consumed
  bytes.

Invalid amount types or ranges throw `TypeError`.

## Protocol order validator

### Types

```ts
type ProtocolRole = "hypervisor" | "worker";
type ProtocolDirection = "sent" | "received";
type ProtocolFrameDisposition = "deliver" | "discard";

type ProtocolPhase =
  | "new"
  | "hello"
  | "welcomed"
  | "readied"
  | "ready"
  | "draining"
  | "drained"
  | "shutdown"
  | "protocol_error";

type WorkStreamTerminal = "end" | "cancel" | "error";

type WorkStreamStatus =
  | "open"
  | "accepted"
  | "started"
  | "half_closed"
  | "terminating";

type ProtocolFrameAcceptance<T> = Readonly<{
  frame: T;
  disposition: ProtocolFrameDisposition;
}>;
```

`discard` applies only to valid crossed inbound work events after the local side
has sent cancel/error. The validator still performs every order, sequence, and
credit transition; the caller must suppress delivery to workload code. A crossed
`work.accepted` remains deliverable so the Hypervisor can settle its claim.

```ts
type ProtocolOrderValidatorOptions = Readonly<{
  role: ProtocolRole;
  maxCapacity?: number;
  maxLifetimeStreams?: number;
  maxDataPayloadBytes?: number;
  maxReceiveCreditBytes?: number;
}>;

type ProtocolOrderValidator = Readonly<{
  acceptBinary(
    direction: ProtocolDirection,
    frame: unknown,
  ): ProtocolFrameAcceptance<WorkDataFrame>;
  acceptControl(
    direction: ProtocolDirection,
    frame: unknown,
  ): ProtocolFrameAcceptance<ControlFrame>;
  snapshot(): ProtocolStateSnapshot;
}>;

function createProtocolOrderValidator(
  options: ProtocolOrderValidatorOptions,
): ProtocolOrderValidator;
```

The role is required. Optional admissions default to their v1 hard limits, must
be positive safe integers, and cannot exceed those limits.

Both acceptance methods first strictly validate the runtime frame, then enforce
sender direction, lifecycle phase, connection fencing, work declaration,
capacity, stream lifetime, sequence, credit, and directional terminal order.
Violations throw `ProtocolViolation`.

### Connection order

The normal handshake phases are:

```text
new --hello--> hello --welcome--> welcomed --ready--> readied
    --ready_ack--> ready --drain--> draining --drained--> drained
```

`ready_ack`, not `ready`, enters working state. `shutdown` is terminal from an
authenticated phase. `protocol_error` is terminal from any phase except an
already terminal shutdown/error phase.

Only a worker may send `hello`, `ready`, `heartbeat`, `drained`,
`work.accepted`, and `work.metadata`. Only a Hypervisor may send `welcome`,
`ready_ack`, `drain`, `shutdown`, `work.open`, and `work.start`. The terminal,
credit, error, and binary data frames are bidirectional.

Heartbeats begin at sequence zero and remain contiguous. Their inflight plus
available capacity cannot exceed the declared worker capacity. Connection IDs
must match the current Welcome.

### Work order and no replay

`work.open` is legal only in Ready, for a declared workload, within active
capacity, with a never-used stream ID. `work.accepted` reserves but does not
authorize execution. The Hypervisor must durably commit acceptance before
sending `work.start`; the worker must not invoke workload code before delivered
Start.

Metadata, credit, data, and normal End require Start. Binary sequences begin at
zero independently in each direction and consume credit granted by the opposite
peer. The worker must send its single response metadata before worker data or
normal End.

End is a directional half-close. Cancel and Error request whole-stream abort. A
side that already sent End may upgrade that half exactly once to Cancel or Error
until the peer terminates. Abort terminals cannot repeat or downgrade. A stream
retires as End/End or Abort/Abort; mixed End/Abort stays active until the End
side upgrades.

Bounded End/End tombstones preserve crossed-frame ordering without consuming
capacity. They allow one late abort upgrade and discard credit that was sent
before the peer observed End. Used stream IDs remain retained separately for the
lifetime no-reuse rule.

## Protocol snapshots

```ts
type WorkStreamSnapshot = Readonly<{
  streamId: string;
  status: WorkStreamStatus;
  accepted: boolean;
  started: boolean;
  sentTerminal?: WorkStreamTerminal;
  receivedTerminal?: WorkStreamTerminal;
  nextSentSequence: number;
  nextReceivedSequence: number;
  sendCredit: number;
  receiveCredit: number;
}>;

type ProtocolStateSnapshot = Readonly<{
  role: ProtocolRole;
  phase: ProtocolPhase;
  identity?: WorkerIdentity;
  workloads?: readonly string[];
  connectionId?: string;
  capacity?: number;
  nextHeartbeatSequence: number;
  activeStreamCount: number;
  usedStreamCount: number;
  maxLifetimeStreams: number;
  streams: readonly WorkStreamSnapshot[];
}>;
```

Snapshots are synchronous point-in-time copies. `activeStreamCount` excludes
normal terminal tombstones; `usedStreamCount` includes every stream ID ever
opened on this connection. `sendCredit` and `receiveCredit` are currently
available byte windows, not cumulative totals.

## Protocol violations

```ts
type ProtocolViolationCode =
  | "capacity_exceeded"
  | "control_frame_too_large"
  | "credit_exceeded"
  | "data_payload_too_large"
  | "duplicate_stream"
  | "invalid_binary_frame"
  | "invalid_control_frame"
  | "invalid_direction"
  | "invalid_protocol_order"
  | "post_terminal_frame"
  | "sequence_mismatch"
  | "stale_connection"
  | "stream_limit_exceeded"
  | "unknown_stream"
  | "unsupported_frame_type"
  | "unsupported_protocol"
  | "unsupported_workload";

type ProtocolViolation =
  & TypeError
  & Readonly<{
    code: ProtocolViolationCode;
    protocolViolation: true;
  }>;
```

```ts
function createProtocolViolation(
  code: ProtocolViolationCode,
  message: string,
): ProtocolViolation;

function isProtocolViolation(
  value: unknown,
): value is ProtocolViolation;

function throwProtocolViolation(
  code: ProtocolViolationCode,
  message: string,
): never;
```

Oxian uses a symbol marker in addition to the public fields, so
`isProtocolViolation` does not accept an arbitrary lookalike object.
`createProtocolViolation` returns a `TypeError` with immutable enumerable `code`
and `protocolViolation` properties. `throwProtocolViolation` creates and throws
the same value.

Use the code for machine behavior and the message for diagnostics:

```ts
try {
  validator.acceptControl("received", candidate);
} catch (error) {
  if (isProtocolViolation(error)) {
    console.error("peer violation", error.code);
  }
  throw error;
}
```

The normative cross-peer lifecycle, including crossed terminal races and
disconnect settlement, is described in
[Oxian worker protocol v1](../worker-protocol-v1.md).
