import type {
  JsonObject,
  WorkerCredential,
  WorkerIdentity,
} from "../protocol/types.ts";
import type { SupervisorError, SupervisorErrorCode } from "./internal.ts";

export type WorkerDefinition = Readonly<{
  workerId: string;
  providerId: string;
  workloads: readonly string[];
  capacity: number;
  providerConfig: JsonObject;
  labels: JsonObject;
}>;

export type WorkerAttemptPhase =
  | "requested"
  | "launching"
  | "running"
  | "terminating"
  | "terminated"
  | "failed";

export type WorkerAttemptFailure = Readonly<{
  code: string;
  message: string;
}>;

export type WorkerAttempt = Readonly<{
  identity: WorkerIdentity;
  phase: WorkerAttemptPhase;
  providerInstanceId?: string;
  failure?: WorkerAttemptFailure;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type WorkerAttemptEvent =
  | Readonly<{ type: "launching" }>
  | Readonly<{ type: "running"; providerInstanceId: string }>
  | Readonly<{ type: "terminate" }>
  | Readonly<{ type: "terminated" }>
  | Readonly<{ type: "failed"; code: string; message: string }>;

export type WorkerSessionPhase =
  | "connected"
  | "ready"
  | "draining"
  | "drained"
  | "expired"
  | "closed";

export type SessionFence = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  sessionGeneration: number;
}>;

export type WorkerSession = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  /**
   * Authority-issued monotonic fence within this worker attempt.
   */
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

export type RegistrationGrant = Readonly<{
  identity: WorkerIdentity;
  credential: WorkerCredential;
  expiresAtMs: number;
}>;

export type RegistrationExchange = Readonly<{
  identity: WorkerIdentity;
  handshakeId: string;
  /**
   * Authority-issued monotonic fence for successful sessions of this attempt.
   * Exact lost-Welcome replay returns the same generation.
   */
  sessionGeneration: number;
  authenticatedWith: WorkerCredential["kind"];
  resume: RegistrationGrant;
}>;

export type WorkDispatchStatus =
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

export type WorkAssignment = Readonly<{
  fence: SessionFence;
  streamId: string;
}>;

/**
 * Immutable owner intent to route one operation to an exact worker.
 *
 * The target names the logical worker, not a particular attempt or socket.
 * Session fencing still determines which current connection may receive work.
 */
export type WorkDispatchTarget = Readonly<{
  workerId: string;
}>;

export type WorkDispatch = Readonly<{
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
  cancellation?: Readonly<{
    code?: string;
    message?: string;
  }>;
  terminal?: Readonly<{
    code?: string;
    message?: string;
  }>;
}>;

export type { SupervisorError, SupervisorErrorCode };
