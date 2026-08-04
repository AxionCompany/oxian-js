import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";
import type {
  AcceptanceCommit,
  SessionRegistry,
  WorkDispatch,
  WorkDispatchStatus,
  WorkDispatchTarget,
} from "../supervisor/index.ts";
import type { WorkerWorkHandler } from "../worker/types.ts";

export type WorkerHostInputBody =
  | Uint8Array
  | ReadableStream<Uint8Array>;

export type WorkerHostDispatchInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
  metadata?: JsonObject;
  body?: WorkerHostInputBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

export type WorkerHostWorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;

export type WorkerHostScheduler = Readonly<{
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}>;

export type WorkerHostOptions = Readonly<{
  persistAcceptance(commit: AcceptanceCommit): Promise<void>;
  sessions?: SessionRegistry;
  clock?: () => number;
  scheduler?: WorkerHostScheduler;
  createConnectionId?: () => string;
  createAttemptId?: () => string;
  heartbeatIntervalMs?: number;
  leaseTimeoutMs?: number;
}>;

export type InProcessWorkerOptions = Readonly<{
  workerId: string;
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
}>;

export type InProcessWorkerState =
  | "ready"
  | "draining"
  | "drained"
  | "stopping"
  | "stopped";

export type InProcessWorkerSnapshot = Readonly<{
  state: InProcessWorkerState;
  identity: WorkerIdentity;
  connectionId: string;
  workloads: readonly string[];
  capacity: number;
  activeWork: number;
}>;

export type InProcessWorker = Readonly<{
  readonly identity: WorkerIdentity;
  readonly workloads: readonly string[];
  readonly capacity: number;
  drain(): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): InProcessWorkerSnapshot;
}>;

export type WorkerHostSnapshot = Readonly<{
  acceptingWorkers: boolean;
  acceptingWork: boolean;
  workers: number;
  sessions: number;
  work: Readonly<Record<WorkDispatchStatus, number>>;
}>;

export type WorkerHost = Readonly<{
  dispatch(input: WorkerHostDispatchInput): Promise<WorkerHostWorkHandle>;
  attachInProcessWorker(options: InProcessWorkerOptions): InProcessWorker;
  drain(workerId: string): Promise<void>;
  shutdownWorker(workerId: string, reason?: string): Promise<void>;
  shutdown(reason?: string): Promise<void>;
  snapshot(): WorkerHostSnapshot;
  readonly sessions: SessionRegistry;
}>;

export type WorkerHostErrorCode =
  | "indeterminate"
  | "invalid_state"
  | "shutting_down"
  | "worker_unavailable"
  | "work_failed";

export type WorkerHostError =
  & Error
  & Readonly<{
    name: "WorkerHostError";
    code: WorkerHostErrorCode;
    identity?: WorkerIdentity;
    operationId?: string;
  }>;
