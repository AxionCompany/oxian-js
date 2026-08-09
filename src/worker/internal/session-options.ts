import type {
  JsonObject,
  WorkerCredential,
  WorkerIdentity,
} from "../../protocol/index.ts";
import type { WorkerLifecycleCallbacks } from "../../lifecycle/types.ts";
import type { FrameConnection } from "../../transport/frame.ts";
import type { WorkerTransport } from "../../transport/declarations.ts";
import type {
  WorkerBeforeReadyContext,
  WorkerHeartbeatContext,
  WorkerReconnectDelay,
  WorkerResumeCredentialPersister,
  WorkerSnapshot,
  WorkerWebSocketLimits,
  WorkerWorkHandler,
} from "../types.ts";

export type WorkerCredentialPersistence =
  | Readonly<{
    credentialPersistence?: "durable";
    persistResumeCredential: WorkerResumeCredentialPersister;
  }>
  | Readonly<{
    credentialPersistence: "ephemeral";
    persistResumeCredential?: never;
  }>;

/** Canonical protocol-session input after the public Worker lifecycle bootstrap. */
export type WorkerSessionOptions =
  & Readonly<{
    workloads: Readonly<Record<string, WorkerWorkHandler>>;
    capacity?: number;
    signal?: AbortSignal;
    transport: Readonly<{
      type: WorkerTransport["type"];
      connect(signal: AbortSignal): Promise<FrameConnection>;
      limits?: WorkerWebSocketLimits;
    }>;
    identity: WorkerIdentity;
    credential: WorkerCredential;
    handshakeId?: string;
    resumeExpiresAtMs?: number;
    handshakeTimeoutMs?: number;
    readyTimeoutMs?: number;
    resumeExpirySkewMs?: number;
    inputBufferBytes?: number;
    createHeartbeatMetadata?: (
      context: WorkerHeartbeatContext,
    ) => JsonObject | void | Promise<JsonObject | void>;
    reconnectDelay?: WorkerReconnectDelay | false;
    maxReconnectDelayMs?: number;
    createHandshakeId?: () => string;
    now?: () => number;
    beforeReady?: (
      context: WorkerBeforeReadyContext,
    ) => JsonObject | void | Promise<JsonObject | void>;
    onStateChange?: (
      snapshot: WorkerSnapshot,
    ) => void | Promise<void>;
    onReenrollmentRequired?: (error: unknown) => void | Promise<void>;
    lifecycle?: WorkerLifecycleCallbacks;
  }>
  & WorkerCredentialPersistence;
