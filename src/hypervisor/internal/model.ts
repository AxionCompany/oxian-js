import type {
  HelloFrame,
  JsonObject,
  WorkStreamTerminal,
} from "../../protocol/index.ts";
import type {
  RegistrationExchange,
  SessionFence,
  WorkDispatch,
  WorkerDefinition,
} from "../../supervisor/index.ts";
import type { WebSocketTransport } from "../../transport/index.ts";
import type { WorkerWireConnection } from "../../transport/types.ts";
import type {
  HypervisorDisconnectPhase,
  HypervisorDisconnectReason,
  HypervisorPeerClose,
  HypervisorWorkHandle,
  HypervisorWorkInputBody,
} from "../types.ts";

export type ConnectionPhase =
  | "pending"
  | "unauthenticated"
  | "authenticated"
  | "ready"
  | "closed";

export type ConnectionRecord = {
  connection?: WorkerWireConnection;
  transport?: WebSocketTransport;
  phase: ConnectionPhase;
  connectedAtMs: number;
  acceptingWork: boolean;
  openedStreams: number;
  connectionId?: string;
  hello?: HelloFrame;
  exchange?: RegistrationExchange;
  definition?: WorkerDefinition;
  fence?: SessionFence;
  sessionPhase?: HypervisorDisconnectPhase;
  disconnectReason?: HypervisorDisconnectReason;
  peerClose?: HypervisorPeerClose;
  authenticatedSlot: boolean;
  unauthenticatedSlot: boolean;
  handshakeExternalOperations: number;
  readyExternalOperations: number;
  handshakeTimer?: unknown;
  attachmentTimer?: unknown;
  readyTimer?: unknown;
  drainTimer?: unknown;
  drainMode?: "rotate" | "shutdown";
  drainPromise?: Promise<void>;
  drainFinishing?: boolean;
  resolveDrain?: () => void;
  ageTimer?: unknown;
  abort: AbortController;
  pending: Map<string, PendingWork>;
  cleanup?: Promise<void>;
};

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

export type PendingWork = {
  record: ConnectionRecord;
  operationId: string;
  streamId: string;
  fence: SessionFence;
  body?: Uint8Array | ReadableStream<Uint8Array>;
  inputReader?: ReadableStreamDefaultReader<Uint8Array>;
  inputBuffer?: Uint8Array;
  inputOffset: number;
  inputCredit: number;
  inputSequence: number;
  inputPumping: boolean;
  localTerminal: boolean;
  localAborted: boolean;
  peerTerminal?: WorkStreamTerminal;
  startedValue: boolean;
  metadataValue: boolean;
  outputClosed: boolean;
  outputCredit: number;
  outputGranting: boolean;
  outputController?: ReadableStreamDefaultController<Uint8Array>;
  inputAbort: AbortController;
  started: Deferred<void>;
  metadata: Deferred<JsonObject>;
  completed: Deferred<WorkDispatch>;
  deadlineTimer?: unknown;
  cancellationTimer?: unknown;
  handle?: HypervisorWorkHandle;
};

export type PendingOpenInput = Readonly<{
  streamId: string;
  workload: string;
  metadata: JsonObject;
  body?: HypervisorWorkInputBody;
  deadlineAtMs?: number;
}>;

export type AcceptanceAdmissionState = {
  pending: number;
  readonly byWorker: Map<string, number>;
};

export type CloseRecord = (
  record: ConnectionRecord,
  code: number,
  wireReason: string,
  disconnectReason: HypervisorDisconnectReason,
) => Promise<void>;

export type DrainRecord = (
  record: ConnectionRecord,
  reason: string,
  mode?: "rotate" | "shutdown",
  timeoutMs?: number,
) => Promise<void>;
