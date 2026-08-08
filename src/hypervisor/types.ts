import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";
import type {
  AcceptanceCommit,
  RegistrationAuthority,
  RegistrationExchange,
  SessionRegistry,
  WorkDispatchStatus,
  WorkerDefinition,
  WorkerRepository,
} from "../supervisor/index.ts";
import type { SessionFence } from "../supervisor/types.ts";
import type { WorkerWireConnection } from "../transport/types.ts";
import type { WorkHandle, WorkInput } from "../work/types.ts";
import type { HypervisorConfig } from "./config.ts";

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

/**
 * Admission policy for workers that cross an untrusted transport boundary.
 * In-process workers are admitted by direct object possession and do not need
 * repository or credential ceremony.
 */
export type HypervisorAdmission = Readonly<{
  type: "registered";
  authority: WorkerAdmissionAuthority;
  repository: WorkerAdmissionRepository;
  bootstrap?(
    input: Readonly<{
      identity: WorkerIdentity;
      definition: WorkerDefinition;
      exchange: RegistrationExchange;
      signal: AbortSignal;
    }>,
  ): JsonObject | Promise<JsonObject>;
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
}>;

export type HypervisorOptions = Readonly<{
  admission?: HypervisorAdmission;
  persistAcceptance(
    commit: AcceptanceCommit,
  ): Promise<void>;
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
  inProcessWorkers: number;
  pendingAcceptanceCommits: number;
  pendingAcceptanceCommitsByWorker: readonly Readonly<{
    workerId: string;
    count: number;
  }>[];
  work: Readonly<Record<WorkDispatchStatus, number>>;
}>;

export type HypervisorRequestDecision =
  | Readonly<{
    kind: "response";
    response: Response | Promise<Response>;
  }>
  | Readonly<{
    kind: "upgrade";
    protocol: string;
    /**
     * Attaches the runtime-upgraded server connection exactly once.
     * `negotiatedProtocol` is required only when the native connection cannot
     * expose the selected subprotocol itself.
     */
    attach(
      connection: WorkerWireConnection,
      negotiatedProtocol?: string,
    ): void;
    /** Releases the reserved admission slot when a runtime upgrade fails. */
    cancel(reason?: string): void;
  }>;

export type Hypervisor = Readonly<{
  /**
   * Produces a runtime-neutral HTTP response or one-shot WebSocket upgrade
   * admission. A server adapter owns the native handshake and listener.
   */
  prepare(request: Request): HypervisorRequestDecision;
  dispatch(input: WorkInput): Promise<WorkHandle>;
  /**
   * Gracefully drains one ready Worker connection or direct binding, then lets
   * the Worker establish its next session.
   *
   * This is a maintenance/rotation primitive, not a terminal worker stop.
   * It is a no-op when the worker has no active ready session.
   */
  drain(workerId: string, reason?: string): Promise<void>;
  /**
   * Gracefully drains one ready Worker session, sends the protocol `Shutdown`
   * frame when remote, and closes it. The Worker settles `run()` with
   * `reason: "shutdown"` instead of reconnecting.
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
