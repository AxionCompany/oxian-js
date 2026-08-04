# Supervisor API

[← API reference](../api-reference.md)

The supervisor subpath contains the transport-independent worker authority,
session fencing, admission, and work-dispatch state machines.

```ts
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createSessionRegistry,
  createWorkDispatcher,
  createWorkerDefinition,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/supervisor";
```

The reference implementations are process-local. `WorkerRepository` and
`RegistrationAuthority` are asynchronous contracts so an application can put
worker epochs, credential rotation, and acceptance in its own durable store.
`SessionRegistry` is intentionally never durable: it owns only sockets attached
to one Hypervisor process.

## Exports

| Area         | Public exports                                                                                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker state | `WorkerDefinition`, `WorkerAttemptPhase`, `WorkerAttemptFailure`, `WorkerAttempt`, `WorkerAttemptEvent`, `WorkerActivation`, `WorkerRepository`, `createWorkerDefinition`, `createWorkerAttempt`, `transitionWorkerAttempt`, `isTerminalAttempt`, `createInMemoryWorkerRepository` |
| Registration | `RegistrationGrant`, `RegistrationExchange`, `RegistrationAuthority`, `RegistrationAuthorityHooks`, `createRegistrationAuthority`, `createInMemoryRegistrationAuthority`                                                                                                           |
| Sessions     | `WorkerSessionPhase`, `SessionFence`, `WorkerSession`, `SessionAttachment`, `SessionLease`, `SessionReservationInput`, `SessionRegistry`, `createSessionFence`, `createWorkerSession`, `sessionFence`, `fenceForSession`, `createSessionRegistry`                                  |
| Dispatch     | `WorkDispatchStatus`, `WorkAssignment`, `WorkDispatchTarget`, `WorkDispatch`, `AcceptanceCommit`, `WorkDispatcher`, `createWorkDispatchTarget`, `createWorkDispatcher`                                                                                                             |
| Errors       | `SupervisorErrorCode`, `SupervisorError`                                                                                                                                                                                                                                           |

## Worker definitions and attempts

### `WorkerDefinition`

```ts
type WorkerDefinition = Readonly<{
  workerId: string;
  providerId: string;
  workloads: readonly string[];
  capacity: number;
  providerConfig: JsonObject;
  labels: JsonObject;
}>;
```

`createWorkerDefinition(input)` validates, copies, and freezes a definition:

```ts
function createWorkerDefinition(
  input: Readonly<{
    workerId: string;
    providerId: string;
    workloads: readonly string[];
    capacity: number;
    providerConfig?: JsonObject;
    labels?: JsonObject;
  }>,
): WorkerDefinition;
```

Worker and provider IDs are bounded identifiers. `workloads` must be a
non-empty, unique array of workload identifiers, and `capacity` must be a
positive safe integer. Omitted JSON fields become frozen empty objects.

### `WorkerAttempt`

```ts
type WorkerAttemptPhase =
  | "requested"
  | "launching"
  | "running"
  | "terminating"
  | "terminated"
  | "failed";

type WorkerAttemptFailure = Readonly<{
  code: string;
  message: string;
}>;

type WorkerAttempt = Readonly<{
  identity: WorkerIdentity;
  phase: WorkerAttemptPhase;
  providerInstanceId?: string;
  failure?: WorkerAttemptFailure;
  createdAtMs: number;
  updatedAtMs: number;
}>;

type WorkerAttemptEvent =
  | Readonly<{ type: "launching" }>
  | Readonly<{ type: "running"; providerInstanceId: string }>
  | Readonly<{ type: "terminate" }>
  | Readonly<{ type: "terminated" }>
  | Readonly<{ type: "failed"; code: string; message: string }>;
```

The state helpers are pure and return new frozen values:

```ts
function createWorkerAttempt(
  input: Readonly<{
    identity: WorkerIdentity;
    nowMs: number;
  }>,
): WorkerAttempt;

function transitionWorkerAttempt(
  attempt: WorkerAttempt,
  event: WorkerAttemptEvent,
  nowMs: number,
): WorkerAttempt;

function isTerminalAttempt(attempt: WorkerAttempt): boolean;
```

An attempt begins in `requested`. Valid forward transitions are:

| From                   | Events                             |
| ---------------------- | ---------------------------------- |
| `requested`            | `launching`, `terminate`, `failed` |
| `launching`            | `running`, `terminate`, `failed`   |
| `running`              | `terminate`, `failed`              |
| `terminating`          | `terminated`, `failed`             |
| `terminated`, `failed` | none                               |

Timestamps must be non-negative safe integers and may not move backwards.
Invalid events throw `SupervisorError` with `code: "invalid_state"`.

### `WorkerRepository`

```ts
type WorkerActivation = Readonly<{
  attempt: WorkerAttempt;
  created: boolean;
}>;

type WorkerRepository = Readonly<{
  define(definition: WorkerDefinition): Promise<WorkerDefinition>;
  getDefinition(workerId: string): Promise<WorkerDefinition | undefined>;
  listDefinitions(): Promise<readonly WorkerDefinition[]>;
  activate(workerId: string): Promise<WorkerActivation>;
  transition(
    identity: WorkerIdentity,
    event: WorkerAttemptEvent,
  ): Promise<WorkerAttempt>;
  currentAttempt(workerId: string): Promise<WorkerAttempt | undefined>;
  getAttempt(identity: WorkerIdentity): Promise<WorkerAttempt | undefined>;
  listAttempts(workerId: string): Promise<readonly WorkerAttempt[]>;
  isCurrent(identity: WorkerIdentity): Promise<boolean>;
  assertCurrent(identity: WorkerIdentity): Promise<WorkerAttempt>;
}>;
```

```ts
function createInMemoryWorkerRepository(
  options?: Readonly<{
    clock?: () => number; // default: Date.now
    createAttemptId?: () => string; // default: crypto.randomUUID
  }>,
): WorkerRepository;
```

`define` is create-only. `activate` returns the current non-terminal attempt
with `created: false`, or creates the next monotonically increasing epoch with
`created: true`. Attempt IDs cannot be reused in one repository. `transition`
requires the complete current identity; stale identities fail with
`"stale_attempt"`.

The in-memory implementation performs each mutation synchronously before its
promise is returned, which preserves its compare-and-swap semantics within one
JavaScript process. A durable implementation must make `activate` atomic by
worker ID and make `transition` compare the complete identity and source phase.

## Registration authority

### Contracts

```ts
type RegistrationGrant = Readonly<{
  identity: WorkerIdentity;
  credential: WorkerCredential;
  expiresAtMs: number;
}>;

type RegistrationExchange = Readonly<{
  identity: WorkerIdentity;
  handshakeId: string;
  sessionGeneration: number;
  authenticatedWith: WorkerCredential["kind"];
  resume: RegistrationGrant;
}>;

type RegistrationAuthority = Readonly<{
  issueRegistration(
    identity: WorkerIdentity,
    options?: Readonly<{ ttlMs?: number }>,
  ): Promise<RegistrationGrant>;
  exchange(
    input: Readonly<{
      identity: WorkerIdentity;
      credential: WorkerCredential;
      handshakeId: string;
    }>,
  ): Promise<RegistrationExchange>;
  revoke(identity: WorkerIdentity): Promise<void>;
}>;

type RegistrationAuthorityHooks = Readonly<{
  issueRegistration(
    identity: WorkerIdentity,
    options?: Readonly<{ ttlMs?: number }>,
  ): RegistrationGrant | Promise<RegistrationGrant>;
  exchange(
    input: Readonly<{
      identity: WorkerIdentity;
      credential: WorkerCredential;
      handshakeId: string;
    }>,
  ): RegistrationExchange | Promise<RegistrationExchange>;
  revoke(identity: WorkerIdentity): void | Promise<void>;
}>;
```

`createRegistrationAuthority(hooks)` adapts durable or remote hooks and
validates every value crossing the boundary:

```ts
function createRegistrationAuthority(
  hooks: RegistrationAuthorityHooks,
): RegistrationAuthority;
```

The `exchange` hook is the security transaction. It must atomically consume the
presented credential, issue its resume replacement, increment the attempt-scoped
`sessionGeneration`, and persist a bounded replay keyed by the exact identity,
credential, and handshake ID. An exact lost-Welcome retry returns the same
exchange and generation. Consuming the replacement or revoking the attempt
invalidates the predecessor replay. Credential contents remain opaque to Oxian.

### In-memory authority

```ts
function createInMemoryRegistrationAuthority(
  options?: Readonly<{
    clock?: () => number;
    createCapability?: (
      kind: WorkerCredential["kind"],
      identity: WorkerIdentity,
    ) => string;
    registrationTtlMs?: number; // default: 5 minutes
    resumeTtlMs?: number; // default: 30 days
    handshakeReplayTtlMs?: number; // default: 30 seconds
  }>,
): RegistrationAuthority;
```

All TTLs must be positive safe integers. `issueRegistration` revokes every
existing credential for the identity before minting a one-use registration
credential. `exchange` rotates either a registration or resume credential and
issues a resume grant. Expired credentials fail with `"credential_expired"`;
consumed, mismatched, revoked, or non-exact replays fail with
`"credential_invalid"`.

An exact lost-Welcome replay remains available until the resume credential
minted by that exchange expires, or until that replacement is consumed or
revoked. `handshakeReplayTtlMs` does not shorten that successful replay; it is
the retention window for consumed, revoked, and expired capability tombstones
used to prevent capability-value reuse.

The in-memory authority is useful for one process and local development. It is
not a durable credential authority across replicas or restarts.

## Session authority

### Session values

```ts
type WorkerSessionPhase =
  | "connected"
  | "ready"
  | "draining"
  | "drained"
  | "expired"
  | "closed";

type SessionFence = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  sessionGeneration: number;
}>;

type WorkerSession = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  sessionGeneration: number;
  workloads: readonly string[];
  capacity: number;
  phase: WorkerSessionPhase;
  reserved: number;
  nextHeartbeatSequence: number;
  connectedAtMs: number;
  lastHeartbeatAtMs: number;
  leaseExpiresAtMs: number;
}>;
```

```ts
function createSessionFence(input: SessionFence): SessionFence;

function createWorkerSession(
  input: Readonly<{
    identity: WorkerIdentity;
    connectionId: string;
    sessionGeneration: number;
    workloads: readonly string[];
    capacity: number;
    connectedAtMs: number;
    leaseTimeoutMs: number;
  }>,
): WorkerSession;

function sessionFence(session: WorkerSession): SessionFence;
function fenceForSession(session: WorkerSession): SessionFence;
```

`sessionFence` and `fenceForSession` are equivalent public names. A new session
starts in `connected`, with zero reservations and heartbeat sequence zero.
Connection IDs and generations are part of every fence; a logical worker ID
alone is never sufficient authority.

### `SessionRegistry`

```ts
type SessionAttachment = Readonly<{
  session: WorkerSession;
  replaced?: WorkerSession;
}>;

type SessionLease = Readonly<{
  fence: SessionFence;
  snapshot(): WorkerSession;
  isCurrent(): boolean;
  assertCurrent(): WorkerSession;
}>;

type SessionReservationInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
}>;

type SessionRegistry = Readonly<{
  attach(
    input: Readonly<{
      identity: WorkerIdentity;
      connectionId: string;
      sessionGeneration: number;
      workloads: readonly string[];
      capacity: number;
      leaseTimeoutMs: number;
    }>,
  ): SessionAttachment;
  markReady(fence: SessionFence): WorkerSession;
  heartbeat(
    fence: SessionFence,
    input: Readonly<{ sequence: number }>,
  ): WorkerSession;
  startDrain(fence: SessionFence): WorkerSession;
  markDrained(fence: SessionFence): WorkerSession;
  detach(fence: SessionFence): WorkerSession | undefined;
  expireLeases(): readonly WorkerSession[];
  get(workerId: string): WorkerSession | undefined;
  list(): readonly WorkerSession[];
  assertCurrent(fence: SessionFence): WorkerSession;
  withCurrent<T>(
    fence: SessionFence,
    operation: (session: WorkerSession) => T,
  ): T;
  isCurrent(fence: SessionFence): boolean;
  lease(fence: SessionFence): SessionLease;
  reserve(input: SessionReservationInput): WorkerSession;
  release(fence: SessionFence): WorkerSession;
  releaseIfCurrent(fence: SessionFence): WorkerSession | undefined;
}>;

function createSessionRegistry(
  options?: Readonly<{
    clock?: () => number; // default: Date.now
  }>,
): SessionRegistry;
```

Important behavior:

- `attach` accepts only a generation newer than the process-local high-watermark
  for that exact attempt. A newer valid attachment closes and returns the
  displaced session as `replaced`.
- `connected` is authenticated but not routable. `markReady` starts its
  heartbeat lease; the Hypervisor owns the separate Ready-handshake deadline.
- `heartbeat` accepts only the exact next zero-based sequence and refreshes the
  lease in `ready` or `draining`.
- `startDrain` changes `ready` to `draining`. `markDrained` requires `draining`
  and zero reservations.
- `assertCurrent` throws `"stale_session"` for a displaced, expired, or
  otherwise mismatched fence. `withCurrent` validates and enters its callback in
  one JavaScript turn; do not move that validation past an `await`.
- `reserve` selects only ready sessions supporting the workload with free
  capacity. It prefers the lowest reserved/capacity ratio, then the oldest
  connection, then lexical worker ID. A `target` restricts selection to one
  logical worker. No eligible session throws `"capacity_exhausted"`.
- `release` requires a current reservation. `releaseIfCurrent` is the
  cleanup-safe version and is a no-op for stale fences or zero reservations.
- `get` and `list` remove expired sessions from admission. `expireLeases`
  returns and consumes the accumulated expiration events for lifecycle handling.

The gateway must complete durable credential exchange and repository fencing
before `attach`, and must check the current fence immediately before processing
every inbound frame.

## Work dispatch

### Dispatch values

```ts
type WorkDispatchStatus =
  | "offered"
  | "claimed"
  | "committing"
  | "committed"
  | "cancelling"
  | "reschedulable"
  | "completed"
  | "cancelled"
  | "failed"
  | "indeterminate";

type WorkAssignment = Readonly<{
  fence: SessionFence;
  streamId: string;
}>;

type WorkDispatchTarget = Readonly<{
  workerId: string;
}>;

type WorkDispatch = Readonly<{
  operationId: string;
  workload: string;
  target?: WorkDispatchTarget;
  metadata: JsonObject;
  deadlineAtMs?: number;
  status: WorkDispatchStatus;
  deliveryCount: number;
  assignment?: WorkAssignment;
  openedAtMs: number;
  updatedAtMs: number;
  claimedAtMs?: number;
  committedAtMs?: number;
  cancellation?: Readonly<{ code?: string; message?: string }>;
  terminal?: Readonly<{ code?: string; message?: string }>;
}>;

type AcceptanceCommit = Readonly<{
  operationId: string;
  workload: string;
  target?: WorkDispatchTarget;
  metadata: JsonObject;
  deadlineAtMs?: number;
  deliveryCount: number;
  assignment: WorkAssignment;
  claimedAtMs: number;
}>;
```

`WorkDispatchTarget` is immutable owner intent to route an operation to a
logical worker. The active session fence still decides which exact connection
may receive it.

```ts
function createWorkDispatchTarget(
  input: WorkDispatchTarget,
): WorkDispatchTarget;
```

### `WorkDispatcher`

```ts
type WorkDispatcher = Readonly<{
  offer(
    input: Readonly<{
      workload: string;
      target?: WorkDispatchTarget;
      metadata?: JsonObject;
      deadlineAtMs?: number;
    }>,
  ): WorkDispatch;
  retry(operationId: string): WorkDispatch;
  withdrawOffer(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  discard(operationId: string): WorkDispatch;
  claim(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): WorkDispatch;
  commitAcceptance(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): Promise<WorkDispatch>;
  complete(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): WorkDispatch;
  fail(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    error: Readonly<{ code: string; message: string }>,
  ): WorkDispatch;
  cancel(
    operationId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  confirmCancellation(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  settlePeerTerminal(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal:
      | Readonly<{ type: "cancel"; reason: string }>
      | Readonly<{ type: "error"; code: string; message: string }>,
  ): WorkDispatch;
  connectionLost(fence: SessionFence): readonly WorkDispatch[];
  get(operationId: string): WorkDispatch | undefined;
  list(): readonly WorkDispatch[];
}>;

function createWorkDispatcher(
  options: Readonly<{
    sessions: SessionRegistry;
    persistAcceptance(commit: AcceptanceCommit): Promise<void>;
    clock?: () => number; // default: Date.now
    createWorkStreamId?: () => string; // default: UUID stream ID
  }>,
): WorkDispatcher;
```

The dispatch ledger separates receipt from execution:

1. `offer` reserves session capacity, assigns a new lowercase UUID stream, and
   returns `offered`. The operation ID is generated internally. A past or
   present deadline is rejected.
2. `claim` records the worker's `work.accepted`; the worker is still not
   authorized to execute.
3. `commitAcceptance` calls `persistAcceptance`. Only a confirmed durable commit
   changes the dispatch to `committed`, after which the gateway may send
   `work.start`.
4. `complete`, `fail`, or the cancellation methods close the stream and release
   capacity.

`persistAcceptance` is application-owned durable policy. If it rejects, Oxian
cannot know whether the no-replay boundary committed and returns
`indeterminate`; it never guesses that retry is safe. Connection loss while a
dispatch is `offered` or `claimed` makes it `reschedulable`. Loss while
acceptance persistence is `committing` leaves it there until that promise
settles, then conservatively makes it `indeterminate`; loss after commit is also
`indeterminate`. `retry` creates a new assignment only from `reschedulable`.
`discard` removes a final rescheduling decision after its owner has externalized
it.

`withdrawOffer` is narrower than cancellation: use it only when the caller can
prove `work.open` was never delivered. Once delivery may have occurred, `cancel`
retains capacity until `confirmCancellation`, a peer terminal frame, or
connection loss closes the protocol stream. `settlePeerTerminal` maps worker
rejection from `offered` or `claimed` to `reschedulable`. A peer terminal frame
during `committing` records the rejection but waits for persistence and then
becomes `indeterminate`; post-commit terminal frames map to their conservative
final state.

Final dispatches are removed from the process-local ledger once no commit task
or reservation still needs them. Durable operation history belongs to the
application.

## Errors and validation

```ts
type SupervisorErrorCode =
  | "already_exists"
  | "capacity_exhausted"
  | "credential_expired"
  | "credential_invalid"
  | "invalid_state"
  | "not_found"
  | "stale_attempt"
  | "stale_session";

type SupervisorError =
  & Error
  & Readonly<{
    code: SupervisorErrorCode;
  }>;
```

State and authority failures use `SupervisorError`. Public constructors use
`TypeError` for most malformed shapes, while invalid state-transition payloads
can instead be classified as `SupervisorError` with `code: "invalid_state"`.
Identifiers are at most 128 characters, begin alphanumerically, and then allow
alphanumerics, `.`, `_`, `:`, or `-`; workload identifiers also allow `/`.
Timestamps are non-negative safe integers. Supervisor JSON values must be
finite, acyclic, plain JSON no deeper than 32 levels; accepted inputs are
recursively copied and frozen.
