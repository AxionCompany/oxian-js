import type {
  JsonObject,
  WorkerCredential,
  WorkerIdentity,
} from "../../src/protocol/index.ts";
import {
  adaptSocketConnection,
  connectWorkerWebSocket,
  createFrameConnection,
  type WorkerWebSocketFactory,
} from "../../src/transport/index.ts";
import type {
  Worker,
  WorkerBeforeReadyContext,
  WorkerHeartbeatContext,
  WorkerReconnectDelay,
  WorkerResumeCredentialPersister,
  WorkerSnapshot,
  WorkerWebSocketLimits,
  WorkerWorkHandler,
} from "../../src/worker/index.ts";
import { createWorkerSession } from "../../src/worker/session.ts";

export type ProtocolTestWorkerTransport = Readonly<{
  type: "websocket";
  url: string | URL;
  allowInsecureLoopback?: boolean;
  connectTimeoutMs?: number;
  socket?: WorkerWebSocketFactory;
  limits?: WorkerWebSocketLimits;
}>;

export type ProtocolTestWorkerOptions = Readonly<{
  transport: ProtocolTestWorkerTransport;
  identity: WorkerIdentity;
  credential: WorkerCredential;
  workloads: Readonly<Record<string, WorkerWorkHandler>>;
  capacity?: number;
  signal?: AbortSignal;
  handshakeId?: string;
  resumeExpiresAtMs?: number;
  credentialPersistence?: "durable" | "ephemeral";
  persistResumeCredential?: WorkerResumeCredentialPersister;
  beforeReady?: (
    context: WorkerBeforeReadyContext,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onStateChange?: (snapshot: WorkerSnapshot) => void | Promise<void>;
  onReenrollmentRequired?: (error: unknown) => void | Promise<void>;
  createHeartbeatMetadata?: (
    context: WorkerHeartbeatContext,
  ) => JsonObject | void | Promise<JsonObject | void>;
  reconnectDelay?: WorkerReconnectDelay | false;
  maxReconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
  readyTimeoutMs?: number;
  resumeExpirySkewMs?: number;
  inputBufferBytes?: number;
  createHandshakeId?: () => string;
  now?: () => number;
}>;

/** Keeps 0.20 wire characterization tests focused on the shared session. */
export function createProtocolTestWorker(
  options: ProtocolTestWorkerOptions,
): Worker {
  const physical = options.transport;
  if (physical.socket !== undefined && typeof physical.socket !== "function") {
    throw new TypeError("transport.socket must be a function");
  }
  const persistence = options.credentialPersistence === "ephemeral"
    ? Object.freeze({ credentialPersistence: "ephemeral" as const })
    : Object.freeze({
      credentialPersistence: "durable" as const,
      persistResumeCredential: options.persistResumeCredential!,
    });
  return createWorkerSession({
    transport: Object.freeze({
      type: "websocket" as const,
      limits: physical.limits,
      connect: async (signal: AbortSignal) => {
        const socket = await connectWorkerWebSocket({
          url: physical.url,
          signal,
          ...(physical.connectTimeoutMs === undefined
            ? {}
            : { timeoutMs: physical.connectTimeoutMs }),
          ...(physical.allowInsecureLoopback === undefined
            ? {}
            : { allowInsecureLoopback: physical.allowInsecureLoopback }),
          ...(physical.socket === undefined
            ? {}
            : { createWebSocket: physical.socket }),
        });
        return await createFrameConnection(adaptSocketConnection(socket), {
          signal,
          maxInboundFrames: physical.limits?.maxInboundMessages,
          maxInboundBytes: physical.limits?.maxInboundBytes,
          maxPendingSendFrames: physical.limits?.maxPendingSendMessages,
          maxPendingSendBytes: physical.limits?.maxPendingSendBytes,
          maxBufferedAmountBytes: physical.limits?.maxBufferedAmountBytes,
          bufferedAmountLowWaterBytes: physical.limits
            ?.bufferedAmountLowWaterBytes,
          bufferedAmountPollMs: physical.limits?.bufferedAmountPollMs,
        });
      },
    }),
    identity: options.identity,
    credential: options.credential,
    workloads: options.workloads,
    ...persistence,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.handshakeId === undefined
      ? {}
      : { handshakeId: options.handshakeId }),
    ...(options.resumeExpiresAtMs === undefined
      ? {}
      : { resumeExpiresAtMs: options.resumeExpiresAtMs }),
    ...(options.beforeReady === undefined
      ? {}
      : { beforeReady: options.beforeReady }),
    ...(options.onStateChange === undefined
      ? {}
      : { onStateChange: options.onStateChange }),
    ...(options.onReenrollmentRequired === undefined
      ? {}
      : { onReenrollmentRequired: options.onReenrollmentRequired }),
    ...(options.createHeartbeatMetadata === undefined
      ? {}
      : { createHeartbeatMetadata: options.createHeartbeatMetadata }),
    ...(options.reconnectDelay === undefined
      ? {}
      : { reconnectDelay: options.reconnectDelay }),
    ...(options.maxReconnectDelayMs === undefined
      ? {}
      : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
    ...(options.readyTimeoutMs === undefined
      ? {}
      : { readyTimeoutMs: options.readyTimeoutMs }),
    ...(options.resumeExpirySkewMs === undefined
      ? {}
      : { resumeExpirySkewMs: options.resumeExpirySkewMs }),
    ...(options.inputBufferBytes === undefined
      ? {}
      : { inputBufferBytes: options.inputBufferBytes }),
    ...(options.createHandshakeId === undefined
      ? {}
      : { createHandshakeId: options.createHandshakeId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
