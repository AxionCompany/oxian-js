import { createWorkerIdentity, type JsonObject } from "../protocol/index.ts";
import type {
  WorkerActivationContext,
  WorkerActivationResult,
  WorkerLifecycleCallbacks,
  WorkerLifecycleEvent,
  WorkerRegistration,
  WorkerRegistrationContext,
} from "../lifecycle/index.ts";
import {
  connectInProcessFabric,
  inProcessFabricProvisioning,
} from "../transport/in-process.ts";
import {
  adaptSocketConnection,
  connectWorkerWebSocket,
  createFrameConnection,
} from "../transport/index.ts";
import { expectPositiveInteger } from "./internal/validation.ts";
import { createAbortError } from "./internal/errors.ts";
import { createWorkerSession } from "./session.ts";
import type {
  Worker,
  WorkerOptions,
  WorkerResult,
  WorkerSnapshot,
} from "./types.ts";

function expectWorkerId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 512
  ) {
    throw new TypeError(
      "worker id must be a non-empty bounded string without surrounding whitespace",
    );
  }
  return value;
}

function lifecycleContext<T extends string>(
  stage: T,
  signal: AbortSignal,
  stageId = `${stage}:${crypto.randomUUID()}`,
): Readonly<{
  stage: T;
  stageId: string;
  callbackAttempt: 1;
  signal: AbortSignal;
}> {
  return Object.freeze({
    stage,
    stageId,
    callbackAttempt: 1 as const,
    signal,
  });
}

function sameIdentity(
  left: ReturnType<typeof createWorkerIdentity>,
  right: ReturnType<typeof createWorkerIdentity>,
): boolean {
  return left.workerId === right.workerId &&
    left.attemptId === right.attemptId &&
    left.epoch === right.epoch;
}

function normalizeActivation(
  value: unknown,
): WorkerActivationResult {
  const candidate = value !== null && typeof value === "object" &&
      "identity" in value
    ? (value as Readonly<{ identity: unknown }>).identity
    : value;
  return Object.freeze({
    identity: createWorkerIdentity(
      candidate as Parameters<typeof createWorkerIdentity>[0],
    ),
  });
}

function normalizeRegistration(
  value: unknown,
  identity: ReturnType<typeof createWorkerIdentity>,
): WorkerRegistration {
  if (value === null || typeof value !== "object") {
    throw new TypeError("register must return a Worker registration record");
  }
  const candidate = value as
    & Partial<WorkerRegistration>
    & Readonly<{ identity?: unknown }>;
  if (candidate.identity !== undefined) {
    const registeredIdentity = createWorkerIdentity(
      candidate.identity as Parameters<typeof createWorkerIdentity>[0],
    );
    if (!sameIdentity(identity, registeredIdentity)) {
      throw new TypeError(
        "register returned a credential for a different Worker identity",
      );
    }
  }
  if (
    candidate.credential?.kind !== "registration" &&
    candidate.credential?.kind !== "resume"
  ) {
    throw new TypeError(
      "register must return a registration or resume credential",
    );
  }
  if (
    typeof candidate.credential.capability !== "string" ||
    candidate.credential.capability.length === 0
  ) {
    throw new TypeError("register returned an empty credential capability");
  }
  if (
    !Number.isSafeInteger(candidate.expiresAtMs) ||
    (candidate.expiresAtMs ?? -1) < 0
  ) {
    throw new TypeError(
      "register expiresAtMs must be a non-negative timestamp",
    );
  }
  return Object.freeze({
    credential: Object.freeze({
      kind: candidate.credential.kind,
      capability: candidate.credential.capability,
    }),
    expiresAtMs: candidate.expiresAtMs!,
    ...(candidate.handshakeId === undefined
      ? {}
      : { handshakeId: candidate.handshakeId }),
    ...(candidate.resumeExpiresAtMs === undefined
      ? {}
      : { resumeExpiresAtMs: candidate.resumeExpiresAtMs }),
  });
}

function validateCallbacks(callbacks: WorkerLifecycleCallbacks): void {
  const names = [
    "onActivate",
    "onRegister",
    "onHandshake",
    "onReady",
    "onWorkAccepted",
    "onStart",
    "onComplete",
    "onDisconnect",
  ] as const;
  for (const name of names) {
    if (
      callbacks[name] !== undefined && typeof callbacks[name] !== "function"
    ) {
      throw new TypeError(`${name} must be a function`);
    }
  }
}

/**
 * Creates and immediately starts one functional Worker capability.
 *
 * Activation, registration, and handshake are application-owned operations.
 * An in-process Worker may omit them and use the Hypervisor transport's
 * ephemeral provisioning implementation.
 */
export function createWorker(
  options: WorkerOptions,
  callbacks: WorkerLifecycleCallbacks = {},
): Worker {
  if (options === null || typeof options !== "object") {
    throw new TypeError("worker options are required");
  }
  if (callbacks === null || typeof callbacks !== "object") {
    throw new TypeError("worker lifecycle callbacks must be an object");
  }
  validateCallbacks(callbacks);
  const id = expectWorkerId(options.id);
  const workloadEntries = Object.entries(options.workloads ?? {});
  if (
    workloadEntries.length === 0 ||
    workloadEntries.some(([name, handler]) =>
      name.length === 0 || typeof handler !== "function"
    )
  ) {
    throw new TypeError(
      "workloads must contain at least one non-empty name and function handler",
    );
  }
  const workloads = Object.freeze(Object.fromEntries(workloadEntries));
  const workloadNames = Object.freeze(workloadEntries.map(([name]) => name));
  const capacity = expectPositiveInteger(options.capacity, "capacity", 1);
  const transport = options.transport;
  if (
    transport?.type !== "in-process" && transport?.type !== "websocket"
  ) {
    throw new TypeError('transport.type must be "in-process" or "websocket"');
  }
  if (transport.config === null || typeof transport.config !== "object") {
    throw new TypeError("transport.config is required");
  }
  if (
    transport.type === "websocket" &&
    (typeof options.activate !== "function" ||
      typeof options.register !== "function")
  ) {
    throw new TypeError(
      "WebSocket Workers require activate and register functions",
    );
  }

  const lifecycle = new AbortController();
  const abortFromOwner = (): void => {
    if (!lifecycle.signal.aborted) {
      lifecycle.abort(
        options.signal?.reason ?? createAbortError("Worker stopped"),
      );
    }
  };
  if (options.signal?.aborted) abortFromOwner();
  else {
    options.signal?.addEventListener("abort", abortFromOwner, { once: true });
  }

  let current: Worker | undefined;
  let state: WorkerSnapshot["state"] = "idle";
  let identity: WorkerSnapshot["identity"];
  let stopping: Promise<void> | undefined;
  let resolveReady!: (snapshot: WorkerSnapshot) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<WorkerSnapshot>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => undefined);
  let eventController:
    | ReadableStreamDefaultController<WorkerLifecycleEvent>
    | undefined;
  const events = new ReadableStream<WorkerLifecycleEvent>({
    start(controller) {
      eventController = controller;
    },
    cancel() {
      eventController = undefined;
    },
  }, new CountQueuingStrategy({ highWaterMark: 64 }));

  const snapshot = (): WorkerSnapshot =>
    current?.snapshot() ?? Object.freeze({
      state,
      transport: transport.type,
      ...(identity === undefined ? {} : { identity }),
      activeStreams: 0,
      occupiedExecutions: 0,
      reconnectAttempt: 0,
    });

  const publish = (value: WorkerSnapshot): void => {
    state = value.state;
    identity = value.identity;
    if ((eventController?.desiredSize ?? 0) > 0) {
      eventController?.enqueue(Object.freeze({
        type: "state" as const,
        snapshot: value,
      }));
    }
  };

  const run = async (): Promise<WorkerResult> => {
    let disconnectReason: unknown = "worker_stopped";
    try {
      lifecycle.signal.throwIfAborted();
      state = "connecting";
      publish(snapshot());
      const localProvisioning = transport.type === "in-process"
        ? inProcessFabricProvisioning(transport.config.topic)
        : undefined;
      const activationOperation = options.activate ??
        (localProvisioning?.activate as typeof options.activate | undefined);
      if (activationOperation === undefined) {
        throw new TypeError(
          "Worker activate is required when its transport has no ephemeral provisioning",
        );
      }
      const activationContext: WorkerActivationContext = Object.freeze({
        ...lifecycleContext("activate", lifecycle.signal),
        workerId: id,
        workloads: workloadNames,
        capacity,
      });
      const activation = normalizeActivation(
        await activationOperation(activationContext),
      );
      identity = activation.identity;
      await callbacks.onActivate?.(Object.freeze({
        ...activationContext,
        ...activation,
      }));
      lifecycle.signal.throwIfAborted();

      const registrationOperation = options.register ??
        (localProvisioning?.register as typeof options.register | undefined);
      if (registrationOperation === undefined) {
        throw new TypeError(
          "Worker register is required when its transport has no ephemeral provisioning",
        );
      }
      const registrationContext: WorkerRegistrationContext = Object.freeze({
        ...lifecycleContext("register", lifecycle.signal),
        identity: activation.identity,
      });
      const registration = normalizeRegistration(
        await registrationOperation(registrationContext),
        activation.identity,
      );
      await callbacks.onRegister?.(Object.freeze({
        ...registrationContext,
        ...registration,
      }));
      lifecycle.signal.throwIfAborted();

      const handshakeMetadata = new Map<string, JsonObject | void>();
      current = createWorkerSession({
        transport: transport.type === "in-process"
          ? Object.freeze({
            type: "in-process" as const,
            limits: undefined,
            connect: async (signal: AbortSignal) => {
              signal.throwIfAborted();
              return await createFrameConnection(
                connectInProcessFabric(transport.config),
                { signal },
              );
            },
          })
          : Object.freeze({
            type: "websocket" as const,
            limits: transport.config.limits,
            connect: async (signal: AbortSignal) => {
              const socket = await connectWorkerWebSocket({
                url: transport.config.url,
                signal,
                ...(transport.config.connectTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: transport.config.connectTimeoutMs }),
                ...(transport.config.allowInsecureLoopback === undefined
                  ? {}
                  : {
                    allowInsecureLoopback:
                      transport.config.allowInsecureLoopback,
                  }),
                ...(transport.config.socket === undefined
                  ? {}
                  : { createWebSocket: transport.config.socket }),
              });
              const limits = transport.config.limits;
              return await createFrameConnection(
                adaptSocketConnection(socket),
                {
                  signal,
                  maxInboundFrames: limits?.maxInboundMessages,
                  maxInboundBytes: limits?.maxInboundBytes,
                  maxPendingSendFrames: limits?.maxPendingSendMessages,
                  maxPendingSendBytes: limits?.maxPendingSendBytes,
                  maxBufferedAmountBytes: limits?.maxBufferedAmountBytes,
                  bufferedAmountLowWaterBytes: limits
                    ?.bufferedAmountLowWaterBytes,
                  bufferedAmountPollMs: limits?.bufferedAmountPollMs,
                },
              );
            },
          }),
        identity: activation.identity,
        credential: registration.credential,
        ...(registration.handshakeId === undefined
          ? {}
          : { handshakeId: registration.handshakeId }),
        ...(registration.resumeExpiresAtMs === undefined
          ? {}
          : { resumeExpiresAtMs: registration.resumeExpiresAtMs }),
        workloads,
        capacity,
        signal: lifecycle.signal,
        credentialPersistence: "durable",
        persistResumeCredential: async (rotation, context) => {
          const handshakeContext = Object.freeze({
            ...lifecycleContext(
              "handshake",
              context.signal,
              `handshake:${activation.identity.workerId}:${rotation.handshakeId}`,
            ),
            identity: activation.identity,
            connectionId: context.connectionId,
            bootstrap: context.bootstrap,
            reconnecting: context.reconnecting,
            rotation,
          });
          const metadata = await options.handshake?.(handshakeContext);
          handshakeMetadata.set(context.connectionId, metadata);
          await callbacks.onHandshake?.(handshakeContext);
        },
        beforeReady: ({ connectionId }) => {
          const metadata = handshakeMetadata.get(connectionId);
          handshakeMetadata.delete(connectionId);
          return metadata;
        },
        onStateChange(value) {
          publish(value);
        },
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
        ...(options.createHeartbeatMetadata === undefined
          ? {}
          : { createHeartbeatMetadata: options.createHeartbeatMetadata }),
        ...(options.reconnectDelay === undefined
          ? {}
          : { reconnectDelay: options.reconnectDelay }),
        ...(options.maxReconnectDelayMs === undefined
          ? {}
          : { maxReconnectDelayMs: options.maxReconnectDelayMs }),
        ...(options.createHandshakeId === undefined
          ? {}
          : { createHandshakeId: options.createHandshakeId }),
        ...(options.now === undefined ? {} : { now: options.now }),
        lifecycle: callbacks,
      });
      const readySnapshot = await current.ready;
      resolveReady(readySnapshot);
      const result = await current.closed;
      disconnectReason = result.reason;
      return result;
    } catch (error) {
      disconnectReason = error;
      rejectReady(error);
      if (lifecycle.signal.aborted) {
        return Object.freeze({ reason: "stopped" as const });
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortFromOwner);
      try {
        await callbacks.onDisconnect?.(Object.freeze({
          ...lifecycleContext("disconnect", lifecycle.signal),
          ...(identity === undefined ? {} : { identity }),
          reason: disconnectReason,
        }));
      } catch {
        // Disconnect is deliberately a nonblocking observer.
      }
      if ((eventController?.desiredSize ?? 0) > 0) {
        eventController?.enqueue(Object.freeze({
          type: "closed" as const,
          reason: disconnectReason,
        }));
      }
      eventController?.close();
      eventController = undefined;
    }
  };

  const closed = run();

  const stop = (reason = "worker_stopped"): Promise<void> => {
    if (stopping !== undefined) return stopping;
    stopping = (async () => {
      if (!lifecycle.signal.aborted) {
        lifecycle.abort(createAbortError(reason));
      }
      await current?.stop(reason);
      await closed.then(() => undefined, () => undefined);
    })();
    return stopping;
  };

  return Object.freeze({ ready, closed, events, stop, snapshot });
}
