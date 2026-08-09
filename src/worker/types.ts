import type {
  JsonObject,
  ProtocolOrderValidatorOptions,
  WorkerCredential,
  WorkerIdentity,
} from "../protocol/index.ts";
import type { WorkerTransport } from "../transport/declarations.ts";
import type {
  WorkerActivate,
  WorkerHandshake,
  WorkerRegister,
} from "../lifecycle/types.ts";

/**
 * Stream chunks are bounded to one v1 data payload (1 MiB). A direct
 * Uint8Array may be larger because its storage is explicitly caller-owned.
 */
export type WorkerBody = Uint8Array | ReadableStream<Uint8Array>;

export type WorkerWorkResult =
  | void
  | WorkerBody
  | Readonly<{
    metadata?: JsonObject;
    body?: WorkerBody | null;
  }>;

export type WorkerWorkContext = Readonly<{
  streamId: string;
  workload: string;
  metadata: JsonObject;
  input: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  sendMetadata(metadata: JsonObject): Promise<void>;
}>;

export type WorkerWorkHandler = (
  context: WorkerWorkContext,
) => WorkerWorkResult | Promise<WorkerWorkResult>;

/**
 * Persist this value atomically. The handshake ID belongs to the resume
 * capability and must survive a process restart with it.
 */
export type WorkerResumeCredentialUpdate = Readonly<{
  credential: Readonly<{
    kind: "resume";
    capability: string;
  }>;
  /**
   * Durable stores use this as the compare-and-set predecessor. A write is
   * valid only when the stored handshake is this value or already equals the
   * candidate `handshakeId`.
   */
  replacesHandshakeId: string;
  handshakeId: string;
  resumeExpiresAtMs: number;
}>;

export type WorkerBeforeReadyContext = Readonly<{
  bootstrap: JsonObject;
  connectionId: string;
  signal: AbortSignal;
  reconnecting: boolean;
}>;

/**
 * A point-in-time worker status snapshot used to create one heartbeat's
 * workload-owned metadata. The object and nested identity are frozen.
 */
export type WorkerHeartbeatContext = Readonly<{
  identity: WorkerIdentity;
  connectionId: string;
  capacity: number;
  sequence: number;
  inflight: number;
  availableCapacity: number;
  draining: boolean;
  signal: AbortSignal;
}>;

export type WorkerReconnectContext = Readonly<{
  attempt: number;
  error: unknown;
  credentialKind: WorkerCredential["kind"];
  resumeExpiresAtMs?: number;
}>;

/**
 * Return a delay in milliseconds, or `null` to stop reconnecting.
 */
export type WorkerReconnectDelay = (
  context: WorkerReconnectContext,
) => number | null | Promise<number | null>;

export type WorkerState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "draining"
  | "drained"
  | "reconnecting"
  | "stopped";

export type WorkerSnapshot = Readonly<{
  state: WorkerState;
  transport: WorkerTransport["type"];
  identity?: WorkerIdentity;
  credentialKind?: WorkerCredential["kind"];
  handshakeId?: string;
  resumeExpiresAtMs?: number;
  connectionId?: string;
  activeStreams: number;
  /**
   * Process-lifetime execution reservations. Unlike `activeStreams`, this
   * includes handlers and output-source cancellation from a lost session that
   * have not actually settled.
   */
  occupiedExecutions: number;
  reconnectAttempt: number;
}>;

export type WorkerResult =
  | Readonly<{
    reason: "shutdown" | "stopped";
  }>
  | Readonly<{
    reason: "reenrollment_required";
    error: unknown;
  }>
  | Readonly<{
    reason: "reconnect_exhausted";
    error: unknown;
  }>;

export type WorkerWebSocketLimits = Readonly<{
  maxInboundMessages?: number;
  maxInboundBytes?: number;
  maxPendingSendMessages?: number;
  maxPendingSendBytes?: number;
  maxBufferedAmountBytes?: number;
  bufferedAmountLowWaterBytes?: number;
  bufferedAmountPollMs?: number;
  protocol?: Omit<ProtocolOrderValidatorOptions, "role">;
}>;

export type WorkerResumeCredentialPersister = (
  update: WorkerResumeCredentialUpdate,
  context: Readonly<{
    signal: AbortSignal;
    connectionId: string;
    bootstrap: JsonObject;
    reconnecting: boolean;
  }>,
) => void | Promise<void>;

type WorkerBaseOptions = Readonly<{
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
}>;

export type WorkerOptions =
  & WorkerBaseOptions
  & Readonly<{
    id: string;
    transport: WorkerTransport;
    activate?: WorkerActivate;
    register?: WorkerRegister;
    handshake?: WorkerHandshake;
    /**
     * Bounds activation, registration, credential rotation, and Hello/Welcome.
     */
    handshakeTimeoutMs?: number;
    /**
     * Bounds workload initialization after Welcome and the subsequent wait for
     * the Hypervisor's durable Ready acknowledgement.
     *
     * This is deliberately independent from `handshakeTimeoutMs`: restoring a
     * workspace or preparing a runtime may be substantially slower than
     * authenticating the connection.
     */
    readyTimeoutMs?: number;
    resumeExpirySkewMs?: number;
    inputBufferBytes?: number;
    /**
     * Creates bounded workload-owned status for every remote heartbeat. Calls are
     * single-flight across ticks and reconnect attempts.
     */
    createHeartbeatMetadata?: (
      context: WorkerHeartbeatContext,
    ) => JsonObject | void | Promise<JsonObject | void>;
    reconnectDelay?: WorkerReconnectDelay | false;
    maxReconnectDelayMs?: number;
    createHandshakeId?: () => string;
    now?: () => number;
  }>;

export type Worker = Readonly<{
  readonly ready: Promise<WorkerSnapshot>;
  readonly closed: Promise<WorkerResult>;
  readonly events: ReadableStream<
    import("../lifecycle/types.ts").WorkerLifecycleEvent
  >;
  stop(reason?: string): Promise<void>;
  snapshot(): WorkerSnapshot;
}>;

export type WorkerErrorCode =
  | "connection_lost"
  | "credential_expired"
  | "credential_rejected"
  | "credential_persistence_failed"
  | "handshake_failed"
  | "initialization_failed"
  | "invalid_server_message"
  | "reconnect_exhausted"
  | "worker_stopped";

export type WorkerError =
  & Error
  & Readonly<{
    code: WorkerErrorCode;
    workerError: true;
    cause?: unknown;
  }>;
