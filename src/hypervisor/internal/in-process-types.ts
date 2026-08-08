import type { WorkerIdentity } from "../../protocol/types.ts";
import type {
  SessionRegistry,
  WorkDispatch,
  WorkDispatcher,
} from "../../supervisor/index.ts";
import type { WorkerWorkHandler } from "../../worker/types.ts";
import type { WorkHandle, WorkInput } from "../../work/types.ts";

export type InProcessScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type InProcessExecutionOptions = Readonly<{
  dispatcher: WorkDispatcher;
  sessions: SessionRegistry;
  clock?: () => number;
  scheduler?: InProcessScheduler;
  createConnectionId?: () => string;
  createAttemptId?: () => string;
  leaseTimeoutMs?: number;
}>;

export type InProcessWorkerInput = Readonly<{
  workerId: string;
  identity?: WorkerIdentity;
  sessionGeneration?: number;
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
  onStateChange?(state: InProcessWorkerState): void;
}>;

export type InProcessWorkerState =
  | "connected"
  | "ready"
  | "draining"
  | "drained"
  | "stopping"
  | "stopped";

export type InProcessWorkerSnapshot = Readonly<{
  state: InProcessWorkerState;
  identity: WorkerIdentity;
  connectionId: string;
  sessionGeneration: number;
  workloads: readonly string[];
  capacity: number;
  activeWork: number;
}>;

export type InProcessWorker = Readonly<{
  readonly identity: WorkerIdentity;
  readonly workloads: readonly string[];
  readonly capacity: number;
  ready(): void;
  drain(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): InProcessWorkerSnapshot;
  readonly closed: Promise<
    Readonly<{
      reason: "drained" | "shutdown";
      detail?: string;
    }>
  >;
}>;

export type InProcessExecutionSnapshot = Readonly<{
  acceptingWorkers: boolean;
  workers: number;
}>;

export type InProcessExecution = Readonly<{
  open(dispatch: WorkDispatch, input: WorkInput): WorkHandle;
  attach(options: InProcessWorkerInput): InProcessWorker;
  has(workerId: string): boolean;
  drain(workerId: string): Promise<void>;
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): InProcessExecutionSnapshot;
  readonly sessions: SessionRegistry;
}>;

export type InProcessExecutionErrorCode =
  | "indeterminate"
  | "invalid_state"
  | "shutting_down"
  | "worker_unavailable"
  | "work_failed";

export type InProcessExecutionError =
  & Error
  & Readonly<{
    name: "HypervisorError";
    code: InProcessExecutionErrorCode;
    identity?: WorkerIdentity;
    operationId?: string;
  }>;
