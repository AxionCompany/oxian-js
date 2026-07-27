import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";
import type {
  AcceptanceCommit,
  RegistrationAuthority,
  RegistrationExchange,
  SessionRegistry,
  WorkDispatch,
  WorkDispatchStatus,
  WorkDispatchTarget,
  WorkerDefinition,
  WorkerRepository,
} from "../supervisor/index.ts";
import type { SessionFence } from "../supervisor/types.ts";
import type { HypervisorConfig } from "./config.ts";

export type HypervisorWorkInputBody =
  | Uint8Array
  | ReadableStream<Uint8Array>;

export type HypervisorDispatchInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
  metadata?: JsonObject;
  body?: HypervisorWorkInputBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

export type HypervisorWorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;

export type HypervisorScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type HypervisorReadyCommitContext = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  metadata: JsonObject;
  signal: AbortSignal;
}>;

export type HypervisorHeartbeatCommitContext = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  metadata: JsonObject;
  signal: AbortSignal;
}>;

export type HypervisorDisconnectPhase =
  | "authenticated"
  | "connected"
  | "ready"
  | "draining"
  | "drained"
  | "expired";

/**
 * Trusted, Hypervisor-authored reason for ending one fenced connection.
 *
 * Peer-provided WebSocket close text is never promoted into this field.
 */
export type HypervisorDisconnectReason =
  | "authentication_rejected"
  | "connection_failed"
  | "drain_failed"
  | "drain_timeout"
  | "handshake_timeout"
  | "lease_expired"
  | "peer_closed"
  | "protocol_rejected"
  | "ready_timeout"
  | "rotation"
  | "session_replaced"
  | "shutdown"
  | "shutdown_timeout"
  | "stale_session"
  | "work_stream_failed";

/**
 * Untrusted close details reported by the remote WebSocket peer.
 *
 * Consumers may retain these for diagnostics, but must not use `reason` for
 * lifecycle decisions, authorization, or durable state transitions.
 */
export type HypervisorPeerClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type HypervisorDisconnectEvent = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  phase: HypervisorDisconnectPhase;
  reason: HypervisorDisconnectReason;
  peerClose?: HypervisorPeerClose;
  disconnectedAtMs: number;
}>;

/**
 * Durable-consumer seam for worker presence and opaque workload status.
 *
 * Ready and heartbeat commits are fail-closed gates. Implementations must use
 * the complete fence as an idempotent compare-and-set key. Durable state must
 * also retain a monotonic per-fence disconnect tombstone or high-watermark:
 * because AbortSignal is advisory, a late Ready commit must never resurrect a
 * fence after its disconnect was observed.
 *
 * Commit hooks execute inside that connection's ordered frame loop. They must
 * not await `dispatch()`, `drain()`, or another operation whose completion
 * requires frames from the same worker. Follow-on orchestration belongs on a
 * separate queue.
 *
 * `onDisconnect` is an exactly-once, nonblocking observer. It must enqueue any
 * durable work and return immediately; observer completion never owns socket
 * cleanup or Hypervisor shutdown.
 */
export type HypervisorSessionLifecycle = Readonly<{
  commitReady(
    context: HypervisorReadyCommitContext,
  ): void | Promise<void>;
  commitHeartbeat(
    context: HypervisorHeartbeatCommitContext,
  ): void | Promise<void>;
  onDisconnect(event: HypervisorDisconnectEvent): void;
}>;

/**
 * Read-only worker state required to admit a WebSocket session.
 *
 * Provisioning and attempt mutation remain orchestration concerns and are not
 * required by the Hypervisor data plane.
 */
export type WorkerAdmissionRepository = Pick<
  WorkerRepository,
  "getDefinition" | "assertCurrent"
>;

/**
 * Registration exchange required to admit a WebSocket session.
 *
 * Issuing registrations and revoking attempts remain Control-plane concerns
 * and are deliberately absent from the Hypervisor data-plane seam.
 */
export type WorkerAdmissionAuthority = Pick<RegistrationAuthority, "exchange">;

export type HypervisorOptions = Readonly<{
  authority: WorkerAdmissionAuthority;
  repository: WorkerAdmissionRepository;
  persistAcceptance(
    commit: AcceptanceCommit,
  ): Promise<void>;
  createBootstrap?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      signal: AbortSignal;
    }>,
  ): JsonObject | Promise<JsonObject>;
  /**
   * Purely validates workload-owned Ready metadata before routing begins.
   *
   * This hook must have no durable or externally visible side effects. Its
   * AbortSignal is advisory and an older validation Promise may settle after
   * replacement; only the Hypervisor's later durable lifecycle gate followed
   * by fenced `markReady` publishes routable readiness.
   */
  validateReady?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      sessionGeneration: number;
      connectionId: string;
      metadata: JsonObject;
      signal: AbortSignal;
    }>,
  ): void | Promise<void>;
  sessionLifecycle?: HypervisorSessionLifecycle;
  config?: Partial<HypervisorConfig>;
  sessions?: SessionRegistry;
  fallback?: (
    request: Request,
  ) => Response | Promise<Response>;
  clock?: () => number;
  scheduler?: HypervisorScheduler;
  createConnectionId?: () => string;
}>;

export type HypervisorListenOptions = Readonly<{
  hostname?: string;
  port?: number;
  signal?: AbortSignal;
}>;

export type HypervisorListener = Readonly<{
  hostname: string;
  port: number;
  url: URL;
  finished: Promise<void>;
  shutdown(): Promise<void>;
}>;

export type HypervisorSnapshot = Readonly<{
  acceptingConnections: boolean;
  connections: number;
  unauthenticatedConnections: number;
  authenticatedConnections: number;
  handshakeOperations: number;
  readyOperations: number;
  sessions: number;
  pendingAcceptanceCommits: number;
  pendingAcceptanceCommitsByWorker: readonly Readonly<{
    workerId: string;
    count: number;
  }>[];
  work: Readonly<Record<WorkDispatchStatus, number>>;
}>;

export type Hypervisor = Readonly<{
  fetch(request: Request): Response | Promise<Response>;
  listen(options?: HypervisorListenOptions): HypervisorListener;
  dispatch(input: HypervisorDispatchInput): Promise<HypervisorWorkHandle>;
  /**
   * Gracefully drains one ready worker connection, then closes it so the
   * WorkerClient reconnects with its resume credential.
   *
   * This is a maintenance/rotation primitive, not a terminal worker stop.
   * It is a no-op when the worker has no active ready session.
   */
  drain(workerId: string, reason?: string): Promise<void>;
  /**
   * Gracefully drains one ready worker connection, sends the protocol
   * `Shutdown` frame, and closes it. A conforming WorkerClient settles
   * `run()` with `reason: "shutdown"` instead of reconnecting.
   *
   * This does not revoke durable worker authority or stop provider compute;
   * those remain application/provider orchestration concerns. An in-flight
   * maintenance drain is upgraded to terminal shutdown. The call is a no-op
   * when the worker has no active session.
   */
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  /**
   * Gracefully terminates only the exact current session named by `fence`.
   *
   * This is a no-op after that session has been replaced. Use it for
   * attempt-scoped orchestration so cleanup for an old attempt can never stop
   * a newer connection that reuses the same logical worker ID.
   */
  shutdownSession(fence: SessionFence, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): HypervisorSnapshot;
  readonly config: HypervisorConfig;
  readonly sessions: SessionRegistry;
}>;

export type HypervisorErrorCode =
  | "authentication_failed"
  | "connection_lost"
  | "handshake_timeout"
  | "indeterminate"
  | "invalid_state"
  | "worker_unavailable"
  | "reschedulable"
  | "shutting_down"
  | "work_failed";

export type HypervisorError =
  & Error
  & Readonly<{
    name: "HypervisorError";
    code: HypervisorErrorCode;
    identity?: WorkerIdentity;
    operationId?: string;
  }>;
