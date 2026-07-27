import type {
  JsonObject,
  ProtocolOrderValidatorOptions,
  WorkerCredential,
  WorkerIdentity,
} from "../protocol/index.ts";
import type { WorkerWebSocketFactory } from "../transport/types.ts";

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

export type WorkerClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "draining"
  | "drained"
  | "reconnecting"
  | "stopped";

export type WorkerClientSnapshot = Readonly<{
  state: WorkerClientState;
  credentialKind: WorkerCredential["kind"];
  handshakeId: string;
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

export type WorkerClientResult =
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

export type WorkerTransportOptions = Readonly<{
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

type WorkerClientBaseOptions = Readonly<{
  url: string | URL;
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
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
  allowInsecureLoopback?: boolean;
  connectTimeoutMs?: number;
  /**
   * Provider-owned socket construction, for example to attach a short-lived
   * Cloud identity header. Oxian still validates the URL, deadline, and exact
   * worker subprotocol around this factory.
   */
  createWebSocket?: WorkerWebSocketFactory;
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
  reconnectDelay?: WorkerReconnectDelay | false;
  maxReconnectDelayMs?: number;
  transport?: WorkerTransportOptions;
  createHandshakeId?: () => string;
  now?: () => number;
  /**
   * Applies workload-owned bootstrap after persistence and before Ready.
   * Reconnect attempts invoke this hook sequentially, never concurrently.
   * Implementations must make repeated bootstrap application idempotent. The
   * signal is advisory: timeout, socket loss, or stop cannot cancel a Promise.
   */
  beforeReady?: (
    context: WorkerBeforeReadyContext,
  ) => JsonObject | void | Promise<JsonObject | void>;
  /**
   * Creates bounded workload-owned status for every heartbeat. Calls are
   * single-flight across ticks and connection attempts. A callback failure or
   * invalid JSON result fails the current session. The signal is
   * session-specific and advisory; a reconnect waits for an unresolved prior
   * callback so callbacks never overlap.
   */
  createHeartbeatMetadata?: (
    context: WorkerHeartbeatContext,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onStateChange?: (
    snapshot: WorkerClientSnapshot,
  ) => void | Promise<void>;
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

export type WorkerClientOptions =
  & WorkerClientBaseOptions
  & WorkerCredentialPersistence;

export type WorkerClient = Readonly<{
  run(): Promise<WorkerClientResult>;
  whenReady(): Promise<WorkerClientSnapshot>;
  stop(reason?: string): Promise<void>;
  snapshot(): WorkerClientSnapshot;
}>;

export type WorkerClientErrorCode =
  | "connection_lost"
  | "credential_expired"
  | "credential_rejected"
  | "credential_persistence_failed"
  | "handshake_failed"
  | "initialization_failed"
  | "invalid_server_message"
  | "reconnect_exhausted"
  | "worker_stopped";

export type WorkerClientError =
  & Error
  & Readonly<{
    code: WorkerClientErrorCode;
    workerClientError: true;
    cause?: unknown;
  }>;
