import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";
import type {
  SessionRegistry,
  WorkDispatchStatus,
  WorkerDefinition,
} from "../supervisor/index.ts";
import type { SessionFence } from "../supervisor/types.ts";
import type { SocketConnection } from "../transport/types.ts";
import type { WorkHandle, WorkInput } from "../work/types.ts";
import type { HypervisorAdmit, HypervisorAssign } from "../lifecycle/types.ts";
import type { HypervisorTransport } from "../transport/declarations.ts";
import type { HypervisorConfig } from "./config.ts";

export type HypervisorScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type HypervisorReadyContext = Readonly<{
  fence: SessionFence;
  definition: WorkerDefinition;
  metadata: JsonObject;
  signal: AbortSignal;
}>;

export type HypervisorHeartbeatContext = Readonly<{
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

export type HypervisorOptions = Readonly<{
  transports: readonly HypervisorTransport[];
  admit?: HypervisorAdmit;
  assign?: HypervisorAssign;
  signal?: AbortSignal;
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
      connection: SocketConnection,
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
   * Gracefully drains one ready Worker connection, then lets the Worker
   * establish its next session.
   *
   * This is a maintenance/rotation primitive, not a terminal worker stop.
   * It is a no-op when the worker has no active ready session.
   */
  drain(workerId: string, reason?: string): Promise<void>;
  /**
   * Gracefully drains one ready Worker session, sends the protocol `Shutdown`
   * frame and closes it. The Worker's `closed` promise settles with
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
