import type {
  JsonObject,
  ProtocolOrderValidatorOptions,
  WorkerCredential,
  WorkerIdentity,
} from "../protocol/index.ts";
import type { WorkerWebSocketFactory } from "../transport/types.ts";
import type { Hypervisor } from "../hypervisor/types.ts";

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
  context: Readonly<{ signal: AbortSignal }>,
) => void | Promise<void>;

type WorkerBaseOptions = Readonly<{
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
  beforeReady?: (
    context: WorkerBeforeReadyContext,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onStateChange?: (
    snapshot: WorkerSnapshot,
  ) => void | Promise<void>;
}>;

export type InProcessWorkerTransport = Readonly<{
  type: "in-process";
  hypervisor: Hypervisor;
}>;

export type WebSocketWorkerTransport = Readonly<{
  type: "websocket";
  url: string | URL;
  allowInsecureLoopback?: boolean;
  connectTimeoutMs?: number;
  /** Provider-owned socket construction for transport-level authentication. */
  socket?: WorkerWebSocketFactory;
  limits?: WorkerWebSocketLimits;
}>;

export type WorkerTransport =
  | InProcessWorkerTransport
  | WebSocketWorkerTransport;

export type InProcessWorkerOptions =
  & WorkerBaseOptions
  & Readonly<{
    id: string;
    transport: InProcessWorkerTransport;
    identity?: never;
    credential?: never;
    createHeartbeatMetadata?: never;
  }>;

type WebSocketWorkerBaseOptions =
  & WorkerBaseOptions
  & Readonly<{
    transport: WebSocketWorkerTransport;
    identity: WorkerIdentity;
    credential: WorkerCredential;
    /**
     * Supply the ID stored with a resume credential. A fresh ID is generated
     * when omitted.
     */
    handshakeId?: string;
    /**
     * Required for locally checking a stored resume credential's expiry.
     */
    resumeExpiresAtMs?: number;
    /**
     * Bounds Hello-to-Welcome authentication and credential persistence.
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
    onReenrollmentRequired?: (error: unknown) => void | Promise<void>;
  }>;

export type WorkerCredentialPersistence =
  | Readonly<{
    /**
     * Durable is the default when a persister is supplied.
     */
    credentialPersistence?: "durable";
    /**
     * Called after Welcome and before bootstrap. Explicit failure before this
     * hook resolves retries the unchanged prior credential and handshake ID.
     * Once it resolves, bootstrap failures use the newly persisted resume.
     * The Promise must resolve only after an atomic durable commit. Repeated
     * calls with the same update must be idempotent, and compare-and-set via
     * `replacesHandshakeId` must prevent an older completion from overwriting a
     * later rotation. The signal is advisory: timeout, socket loss, or stop
     * cannot cancel the returned Promise, and no later persistence call starts
     * until it actually settles.
     */
    persistResumeCredential: WorkerResumeCredentialPersister;
  }>
  | Readonly<{
    /**
     * Explicit process-lifetime opt-in; resume state is lost on restart.
     */
    credentialPersistence: "ephemeral";
    persistResumeCredential?: never;
  }>;

export type WebSocketWorkerOptions =
  & WebSocketWorkerBaseOptions
  & WorkerCredentialPersistence;

export type WorkerOptions = InProcessWorkerOptions | WebSocketWorkerOptions;

export type Worker = Readonly<{
  run(): Promise<WorkerResult>;
  whenReady(): Promise<WorkerSnapshot>;
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
