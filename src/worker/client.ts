import {
  createDrainedFrame,
  createHeartbeatFrame,
  createHelloFrame,
  createProtocolErrorFrame,
  createReadyFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkDataFrame,
  createWorkEndFrame,
  createWorkerIdentity,
  createWorkErrorFrame,
  createWorkMetadataFrame,
  isProtocolViolation,
  type JsonObject,
  type WelcomeFrame,
  WORKER_PROTOCOL_LIMITS,
  type WorkOpenFrame,
  type WorkStreamTerminal,
} from "../protocol/index.ts";
import {
  connectWorkerWebSocket,
  createWebSocketTransport,
  type WebSocketTransport,
  type WebSocketTransportMessage,
} from "../transport/index.ts";
import { createBoundedExponentialBackoff } from "./backoff.ts";
import {
  createAbsoluteTimer,
  createDeferred,
  runBoundedHandshakeStep,
  takeWithTimeout,
  waitForDelay,
  waitForTaskOrStop,
} from "./internal/async.ts";
import { createCredentialRotationCoordinator } from "./internal/credentials.ts";
import {
  createAbortError,
  createWorkerClientError,
  isWorkerClientError,
  safeErrorMessage,
} from "./internal/errors.ts";
import {
  createExecutionLedger,
  type ExecutionReservation,
} from "./internal/execution_ledger.ts";
import {
  createLatestAsyncObserver,
  createOneShotAsyncObserver,
  createPendingSettlementTracker,
  createSessionFence,
  createSingleFlightInvoker,
} from "./internal/lifecycle.ts";
import {
  expectNonNegativeInteger,
  expectPositiveInteger,
} from "./internal/validation.ts";
import {
  bodyAsStream,
  normalizeHandlerResult,
  terminalIsAbort,
} from "./internal/work.ts";
import type {
  WorkerBody,
  WorkerClient,
  WorkerClientOptions,
  WorkerClientResult,
  WorkerClientSnapshot,
  WorkerClientState,
  WorkerHeartbeatContext,
  WorkerReconnectDelay,
  WorkerWorkContext,
} from "./types.ts";

const DEFAULT_CAPACITY = 1;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_READY_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_RESUME_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_INPUT_BUFFER_BYTES = 256 * 1024;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DRAIN_CLOSE_REASON = "worker_drained";
const PERMANENT_AUTH_ERROR_CODES = new Set([
  "authentication_failed",
  "credential_expired",
  "credential_invalid",
  "stale_attempt",
]);

type MutableStream = {
  open: WorkOpenFrame;
  started: boolean;
  executionStarted: boolean;
  reservation?: ExecutionReservation;
  locallyRejected: boolean;
  cancelReason?: string;
  localTerminal?: WorkStreamTerminal;
  remoteTerminal?: WorkStreamTerminal;
  terminalSending?: Promise<void>;
  responseMetadataSent: boolean;
  responseMetadataSending?: Promise<void>;
  abortController: AbortController;
  input: ReadableStream<Uint8Array>;
  inputController?: ReadableStreamDefaultController<Uint8Array>;
  inputClosed: boolean;
  outstandingInputCredit: number;
  creditGrantRunning: boolean;
  sendCredit: number;
  creditWaiters: Set<() => void>;
  nextSendSequence: number;
  returnedOutput?: ReadableStream<Uint8Array>;
  outputReader?: ReadableStreamDefaultReader<Uint8Array>;
  outputCancellation?: Promise<void>;
  executionSettlement?: Readonly<{
    promise: Promise<void>;
    resolve(): void;
  }>;
  cancellationSettlementTracked?: boolean;
  cancelDeadline?: () => void;
};

type SessionResult =
  | Readonly<{ reason: "connection_lost"; error: unknown }>
  | Readonly<{ reason: "rotate" }>
  | Readonly<{ reason: "drained" }>
  | Readonly<{ reason: "shutdown" }>;

type PendingInitialization = Readonly<{
  task: Promise<JsonObject | void>;
}>;

type PendingHeartbeatMetadata = Readonly<{
  task: Promise<JsonObject | void>;
}>;

/**
 * Creates a reconnecting outbound worker. Construction is side-effect free;
 * `run()` owns the connection until stop, shutdown, or re-enrollment.
 */
export function createWorkerClient(
  options: WorkerClientOptions,
): WorkerClient {
  const identity = Object.freeze(createWorkerIdentity(options.identity));
  const workloadEntries = Object.entries(options.workloads);
  if (workloadEntries.length === 0) {
    throw new TypeError("workloads must contain at least one handler");
  }
  for (const [workload, handler] of workloadEntries) {
    if (workload.length === 0 || typeof handler !== "function") {
      throw new TypeError(
        "every workload must have a non-empty name and handler",
      );
    }
  }
  const workloads = Object.freeze(
    Object.fromEntries(workloadEntries),
  ) as Readonly<Record<string, typeof workloadEntries[number][1]>>;
  const workloadNames = Object.freeze(workloadEntries.map(([name]) => name));
  const capacity = expectPositiveInteger(
    options.capacity,
    "capacity",
    DEFAULT_CAPACITY,
    WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
  );
  const handshakeTimeoutMs = expectPositiveInteger(
    options.handshakeTimeoutMs,
    "handshakeTimeoutMs",
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  const readyTimeoutMs = expectPositiveInteger(
    options.readyTimeoutMs,
    "readyTimeoutMs",
    DEFAULT_READY_TIMEOUT_MS,
  );
  const resumeExpirySkewMs = expectNonNegativeInteger(
    options.resumeExpirySkewMs,
    "resumeExpirySkewMs",
    DEFAULT_RESUME_EXPIRY_SKEW_MS,
  );
  const inputBufferBytes = expectPositiveInteger(
    options.inputBufferBytes,
    "inputBufferBytes",
    DEFAULT_INPUT_BUFFER_BYTES,
    WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
  );
  const maxReconnectDelayMs = expectPositiveInteger(
    options.maxReconnectDelayMs,
    "maxReconnectDelayMs",
    DEFAULT_MAX_RECONNECT_DELAY_MS,
  );
  const now = options.now ?? Date.now;
  const createHandshakeId = options.createHandshakeId ??
    (() => crypto.randomUUID());
  const initialHandshakeId = options.handshakeId ?? createHandshakeId();
  // Strict validation is delegated to the Hello factory before any network IO.
  const initialHello = createHelloFrame({
    handshakeId: initialHandshakeId,
    identity,
    credential: options.credential,
    workloads: workloadNames,
    capacity,
  });
  if (
    options.resumeExpiresAtMs !== undefined &&
    (!Number.isSafeInteger(options.resumeExpiresAtMs) ||
      options.resumeExpiresAtMs < 0)
  ) {
    throw new TypeError(
      "resumeExpiresAtMs must be a non-negative safe integer",
    );
  }
  if (
    initialHello.credential.kind === "resume" &&
    options.resumeExpiresAtMs === undefined
  ) {
    throw new TypeError(
      "resumeExpiresAtMs is required with an initial resume credential",
    );
  }
  const credentialPersistence = options.credentialPersistence ?? "durable";
  if (
    credentialPersistence !== "durable" &&
    credentialPersistence !== "ephemeral"
  ) {
    throw new TypeError(
      "credentialPersistence must be durable or ephemeral",
    );
  }
  if (
    credentialPersistence === "durable" &&
    options.persistResumeCredential === undefined
  ) {
    throw new TypeError(
      "persistResumeCredential is required unless credentialPersistence is explicitly ephemeral",
    );
  }
  if (
    credentialPersistence === "ephemeral" &&
    options.persistResumeCredential !== undefined
  ) {
    throw new TypeError(
      "persistResumeCredential cannot be combined with ephemeral credential persistence",
    );
  }
  if (
    options.createHeartbeatMetadata !== undefined &&
    typeof options.createHeartbeatMetadata !== "function"
  ) {
    throw new TypeError("createHeartbeatMetadata must be a function");
  }
  if (
    options.createWebSocket !== undefined &&
    typeof options.createWebSocket !== "function"
  ) {
    throw new TypeError("createWebSocket must be a function");
  }

  const defaultReconnectDelay = createBoundedExponentialBackoff({
    initialDelayMs: Math.min(250, maxReconnectDelayMs),
    maxDelayMs: Math.min(30_000, maxReconnectDelayMs),
  });
  const reconnectDelay: WorkerReconnectDelay | false =
    options.reconnectDelay === undefined
      ? defaultReconnectDelay
      : options.reconnectDelay;
  const stopController = new AbortController();
  const executionLedger = createExecutionLedger(capacity);
  const outputCancellationSettlements = createPendingSettlementTracker();
  const credentials = createCredentialRotationCoordinator({
    initialCredential: initialHello.credential,
    initialHandshakeId,
    ...(options.resumeExpiresAtMs === undefined
      ? {}
      : { initialResumeExpiresAtMs: options.resumeExpiresAtMs }),
    persistence: credentialPersistence === "ephemeral"
      ? Object.freeze({ credentialPersistence: "ephemeral" as const })
      : Object.freeze({
        credentialPersistence: "durable" as const,
        persistResumeCredential: options.persistResumeCredential!,
      }),
    identity,
    workloads: workloadNames,
    capacity,
    handshakeTimeoutMs,
    createHandshakeId,
  });
  const readyDeferred = createDeferred<WorkerClientSnapshot>();
  // A caller may choose not to await readiness; keep that from becoming an
  // unhandled rejection when startup terminates early.
  readyDeferred.promise.catch(() => undefined);
  const runDone = createDeferred<void>();
  const sessionFence = createSessionFence();
  const stateNotifications = createLatestAsyncObserver(
    options.onStateChange,
  );
  const reenrollmentNotifications = createOneShotAsyncObserver(
    options.onReenrollmentRequired,
  );
  const reconnectDelayInvoker = reconnectDelay === false
    ? undefined
    : createSingleFlightInvoker(reconnectDelay, stopController.signal);
  let state: WorkerClientState = "idle";
  let connectionId: string | undefined;
  let activeStreams = 0;
  let reconnectAttempt = 0;
  let runStarted = false;
  let runFinished = false;
  let everReady = false;
  let stopReason = "worker_stopped";
  let pendingInitialization: PendingInitialization | undefined;
  let pendingHeartbeatMetadata: PendingHeartbeatMetadata | undefined;

  const snapshot = (): WorkerClientSnapshot => {
    const credentialState = credentials.current();
    return Object.freeze({
      state,
      credentialKind: credentialState.credential.kind,
      handshakeId: credentialState.handshakeId,
      ...(credentialState.resumeExpiresAtMs === undefined
        ? {}
        : { resumeExpiresAtMs: credentialState.resumeExpiresAtMs }),
      ...(connectionId === undefined ? {} : { connectionId }),
      activeStreams,
      occupiedExecutions: executionLedger.occupied(),
      reconnectAttempt,
    });
  };

  const setState = (next: WorkerClientState): void => {
    state = next;
    stateNotifications.publish(snapshot());
  };

  const settleSerializedWorkBeforeConnect = async (): Promise<void> => {
    const heartbeatMetadata = pendingHeartbeatMetadata;
    if (heartbeatMetadata !== undefined) {
      try {
        await waitForTaskOrStop(
          heartbeatMetadata.task,
          stopController.signal,
        );
      } catch (error) {
        if (stopController.signal.aborted) throw error;
        // The failed session already owns callback failure. A later
        // connection may retry, but never while this invocation is pending.
      }
    }

    const initialization = pendingInitialization;
    if (initialization !== undefined) {
      try {
        await waitForTaskOrStop(
          initialization.task,
          stopController.signal,
        );
      } catch (error) {
        if (stopController.signal.aborted) throw error;
        // A failed bootstrap is retried only on a later connection and never
        // concurrently with its prior attempt.
      }
    }

    await credentials.settlePending(stopController.signal);
  };

  const stopFromExternalSignal = (): void => {
    stopReason = "external_abort";
    const reason = options.signal?.reason ??
      createAbortError("Worker stopped");
    sessionFence.abortCurrent(reason);
    if (!stopController.signal.aborted) {
      stopController.abort(reason);
    }
  };
  if (options.signal?.aborted) {
    stopFromExternalSignal();
  } else {
    options.signal?.addEventListener("abort", stopFromExternalSignal, {
      once: true,
    });
  }

  const runSession = async (): Promise<SessionResult> => {
    const credentialAtConnect = credentials.current();
    const credentialAtHello = credentialAtConnect.credential;
    const handshakeAtHello = credentialAtConnect.handshakeId;
    let transport: WebSocketTransport | undefined;
    let socket: WebSocket | undefined;
    let sessionConnectionId: string | undefined;
    let welcomed = false;
    let rotationRequested = false;
    let draining = false;
    let drainRequestedByPeer = false;
    let drainedFrameQueued = false;
    let drained = false;
    let shutdown = false;
    let fatalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let cancelRotationTimer: (() => void) | undefined;
    let cancelRotationDeadline: (() => void) | undefined;
    let cancelDrainDeadline: (() => void) | undefined;
    let heartbeatRunning = false;
    let heartbeatSequence = 0;
    let drainCompletion: Promise<void> | undefined;
    const streams = new Map<string, MutableStream>();
    const sessionLease = sessionFence.attach((reason) => abortSession(reason));

    const isCurrentSession = (): boolean => sessionLease.isCurrent();

    const syncActiveStreams = (): void => {
      if (isCurrentSession()) activeStreams = streams.size;
    };

    const setSessionState = (next: WorkerClientState): void => {
      if (isCurrentSession()) setState(next);
    };

    const failSession = (error: unknown): void => {
      if (!isCurrentSession() || fatalError !== undefined) return;
      fatalError = error;
      abortSession(error);
      void transport?.close({
        code: 4000,
        reason: "worker_session_failed",
      }).catch(() => undefined);
    };

    const wakeCreditWaiters = (stream: MutableStream): void => {
      for (const wake of stream.creditWaiters) wake();
      stream.creditWaiters.clear();
    };

    const closeInput = (
      stream: MutableStream,
      error?: unknown,
    ): void => {
      if (stream.inputClosed) return;
      stream.inputClosed = true;
      try {
        if (error === undefined) stream.inputController?.close();
        else stream.inputController?.error(error);
      } catch {
        // A canceled stream is already closed from the consumer's perspective.
      }
    };

    const releasePreStartReservation = (stream: MutableStream): void => {
      if (stream.executionStarted) return;
      stream.reservation?.release();
      stream.reservation = undefined;
    };

    const finishStreamIfTerminal = (stream: MutableStream): void => {
      if (
        stream.localTerminal === undefined ||
        stream.remoteTerminal === undefined ||
        terminalIsAbort(stream.localTerminal) !==
          terminalIsAbort(stream.remoteTerminal)
      ) {
        return;
      }
      if (stream.cancelDeadline !== undefined) {
        stream.cancelDeadline();
        stream.cancelDeadline = undefined;
      }
      wakeCreditWaiters(stream);
      closeInput(stream);
      releasePreStartReservation(stream);
      streams.delete(stream.open.streamId);
      syncActiveStreams();
      if (draining) void completeDrainIfIdle();
    };

    const trackCancellationSettlement = (stream: MutableStream): void => {
      if (
        stream.cancellationSettlementTracked ||
        stream.executionSettlement === undefined
      ) {
        return;
      }
      stream.cancellationSettlementTracked = true;
      void outputCancellationSettlements.track(
        stream.executionSettlement.promise,
      );
    };

    const beginOutputCancellation = (
      stream: MutableStream,
      reason: unknown,
    ): Promise<void> | undefined => {
      if (stream.outputCancellation !== undefined) {
        return stream.outputCancellation;
      }
      const reader = stream.outputReader;
      if (reader === undefined) return undefined;
      let cancellation: Promise<void>;
      try {
        cancellation = reader.cancel(reason);
      } catch (error) {
        cancellation = Promise.reject(error);
      }
      const settlement = cancellation.then(
        () => undefined,
        () => undefined,
      );
      stream.outputCancellation = settlement;
      trackCancellationSettlement(stream);
      return settlement;
    };

    const cancelReturnedOutput = (
      stream: MutableStream,
      body: ReadableStream<Uint8Array>,
      reason: unknown,
    ): Promise<void> => {
      const reader = body.getReader();
      if (stream.returnedOutput === body) {
        stream.returnedOutput = undefined;
      }
      stream.outputReader = reader;
      try {
        return beginOutputCancellation(stream, reason) ?? Promise.resolve();
      } finally {
        if (stream.outputReader === reader) {
          stream.outputReader = undefined;
        }
        reader.releaseLock();
      }
    };

    const abortWork = (
      stream: MutableStream,
      reason: unknown,
    ): void => {
      if (!stream.abortController.signal.aborted) {
        stream.abortController.abort(reason);
      }
      closeInput(stream, reason);
      wakeCreditWaiters(stream);
      const cancellation = beginOutputCancellation(stream, reason);
      if (
        cancellation === undefined &&
        stream.returnedOutput !== undefined
      ) {
        try {
          void cancelReturnedOutput(stream, stream.returnedOutput, reason);
        } catch {
          stream.returnedOutput = undefined;
        }
      }
    };

    const sessionAbortController = new AbortController();
    const abortSession = (reason: unknown): void => {
      if (!sessionAbortController.signal.aborted) {
        sessionAbortController.abort(reason);
      }
      for (const stream of streams.values()) abortWork(stream, reason);
    };
    const unsubscribeExecutionLedger = executionLedger.subscribe(() => {
      if (isCurrentSession() && draining) void completeDrainIfIdle();
    });

    const sendLocalTerminal = (
      stream: MutableStream,
      terminal: WorkStreamTerminal,
      error?: unknown,
    ): Promise<void> => {
      if (
        terminalIsAbort(stream.localTerminal) ||
        (stream.localTerminal === "end" && terminal === "end")
      ) {
        return Promise.resolve();
      }
      if (stream.terminalSending !== undefined) {
        const preceding = stream.terminalSending;
        return preceding.then(
          () => sendLocalTerminal(stream, terminal, error),
          (sendError) => {
            if (terminal === "end") throw sendError;
            // Abort intent supersedes an in-flight normal End even when that
            // End failed (for example because peer cancellation raced it).
            return sendLocalTerminal(stream, terminal, error);
          },
        );
      }
      const operation = (async () => {
        if (transport === undefined) {
          throw createWorkerClientError(
            "connection_lost",
            "Cannot terminate work on a closed connection",
          );
        }
        try {
          if (terminal === "end") {
            await transport.sendControl(
              createWorkEndFrame({ streamId: stream.open.streamId }),
            );
          } else if (terminal === "cancel") {
            await transport.sendControl(
              createWorkCancelFrame({
                streamId: stream.open.streamId,
                reason: stream.cancelReason ?? "worker_cancelled",
              }),
            );
          } else {
            await transport.sendControl(
              createWorkErrorFrame({
                streamId: stream.open.streamId,
                code: "workload_failed",
                message: safeErrorMessage(error),
              }),
            );
          }
        } catch (sendError) {
          if (
            terminal !== "end" &&
            isProtocolViolation(sendError) &&
            (sendError.code === "post_terminal_frame" ||
              sendError.code === "unknown_stream")
          ) {
            // A queued peer End may already have completed end/end inside the
            // transport validator. Keep the application-side normal End and
            // let that queued frame finish the stream.
            stream.localTerminal ??= "end";
            finishStreamIfTerminal(stream);
            return;
          }
          throw sendError;
        }
        stream.localTerminal = terminal;
        finishStreamIfTerminal(stream);
      })();
      stream.terminalSending = operation.finally(() => {
        stream.terminalSending = undefined;
      });
      return stream.terminalSending;
    };

    const scheduleInputCredit = (stream: MutableStream): void => {
      if (
        stream.creditGrantRunning ||
        !stream.started ||
        stream.inputClosed ||
        terminalIsAbort(stream.localTerminal) ||
        terminalIsAbort(stream.remoteTerminal) ||
        transport === undefined
      ) {
        return;
      }
      stream.creditGrantRunning = true;
      void (async () => {
        try {
          while (
            stream.started &&
            !stream.inputClosed &&
            !terminalIsAbort(stream.localTerminal) &&
            !terminalIsAbort(stream.remoteTerminal)
          ) {
            const desired = Math.max(
              0,
              Math.floor(stream.inputController?.desiredSize ?? 0),
            );
            const grant = Math.min(
              WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes -
                stream.outstandingInputCredit,
              desired - stream.outstandingInputCredit,
            );
            if (grant <= 0) break;
            await transport?.sendControl(
              createWorkCreditFrame({
                streamId: stream.open.streamId,
                bytes: grant,
              }),
            );
            stream.outstandingInputCredit += grant;
          }
        } catch (error) {
          if (
            !isProtocolViolation(error) ||
            (error.code !== "post_terminal_frame" &&
              error.code !== "unknown_stream")
          ) {
            failSession(error);
          }
        } finally {
          stream.creditGrantRunning = false;
        }
      })();
    };

    const waitForSendCredit = async (
      stream: MutableStream,
    ): Promise<void> => {
      while (stream.sendCredit < 1) {
        const signal = stream.abortController.signal;
        if (signal.aborted) {
          throw signal.reason ?? createAbortError("Work aborted");
        }
        await new Promise<void>((resolve, reject) => {
          const wake = (): void => {
            cleanup();
            resolve();
          };
          const abort = (): void => {
            cleanup();
            reject(signal.reason ?? createAbortError("Work aborted"));
          };
          const cleanup = (): void => {
            stream.creditWaiters.delete(wake);
            signal.removeEventListener("abort", abort);
          };
          stream.creditWaiters.add(wake);
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    };

    const sendBody = async (
      stream: MutableStream,
      body: WorkerBody,
    ): Promise<void> => {
      if (transport === undefined) {
        throw createWorkerClientError(
          "connection_lost",
          "Cannot write work output on a closed connection",
        );
      }
      const callerOwnedBytes = body instanceof Uint8Array;
      const reader = bodyAsStream(body).getReader();
      stream.outputReader = reader;
      try {
        if (stream.abortController.signal.aborted) {
          await beginOutputCancellation(
            stream,
            stream.abortController.signal.reason ??
              createAbortError("Work aborted"),
          );
          return;
        }
        while (true) {
          // One producer chunk may be staged so EOF can be observed without
          // requiring spurious peer credit. No subsequent chunk is pulled
          // until this one has crossed the credited wire window.
          const result = await reader.read();
          if (result.done) break;
          if (!(result.value instanceof Uint8Array)) {
            throw new TypeError(
              "workload output stream must yield Uint8Array chunks",
            );
          }
          if (
            !callerOwnedBytes &&
            result.value.byteLength >
              WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes
          ) {
            throw new RangeError(
              `workload output stream chunk exceeds the ${WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes} byte staging bound`,
            );
          }
          let offset = 0;
          while (offset < result.value.byteLength) {
            await waitForSendCredit(stream);
            const length = Math.min(
              result.value.byteLength - offset,
              stream.sendCredit,
              WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
            );
            if (length < 1) continue;
            const payload = result.value.subarray(offset, offset + length);
            await transport.sendData(
              createWorkDataFrame({
                streamId: stream.open.streamId,
                sequence: stream.nextSendSequence,
                payload,
              }),
              { signal: stream.abortController.signal },
            );
            stream.nextSendSequence++;
            stream.sendCredit -= length;
            offset += length;
          }
        }
      } finally {
        if (stream.outputReader === reader) {
          stream.outputReader = undefined;
        }
        reader.releaseLock();
      }
    };

    const sendResponseMetadata = (
      stream: MutableStream,
      metadata: JsonObject,
    ): Promise<void> => {
      if (
        stream.responseMetadataSent ||
        stream.responseMetadataSending !== undefined
      ) {
        return Promise.reject(
          new TypeError("work response metadata may only be sent once"),
        );
      }
      if (transport === undefined) {
        return Promise.reject(
          createWorkerClientError(
            "connection_lost",
            "Cannot write work metadata on a closed connection",
          ),
        );
      }
      const operation = transport.sendControl(
        createWorkMetadataFrame({
          streamId: stream.open.streamId,
          metadata,
        }),
        { signal: stream.abortController.signal },
      ).then(() => {
        stream.responseMetadataSent = true;
      });
      stream.responseMetadataSending = operation.then(
        () => {
          stream.responseMetadataSending = undefined;
        },
        (error) => {
          stream.responseMetadataSending = undefined;
          throw error;
        },
      );
      return stream.responseMetadataSending;
    };

    const invokeHandler = (stream: MutableStream): void => {
      if (
        stopController.signal.aborted ||
        sessionAbortController.signal.aborted ||
        stream.abortController.signal.aborted ||
        stream.locallyRejected
      ) {
        releasePreStartReservation(stream);
        return;
      }
      const handler = workloads[stream.open.workload];
      const reservation = stream.reservation;
      const executionSettlement = createDeferred<void>();
      stream.executionStarted = true;
      stream.executionSettlement = executionSettlement;
      const context: WorkerWorkContext = Object.freeze({
        streamId: stream.open.streamId,
        workload: stream.open.workload,
        metadata: stream.open.metadata,
        input: stream.input,
        signal: stream.abortController.signal,
        sendMetadata: (metadata: JsonObject): Promise<void> =>
          sendResponseMetadata(stream, metadata),
      });

      void (async () => {
        let returnedBody: WorkerBody | undefined;
        let outputStarted = false;
        const cancelUnstartedOutput = (reason: unknown): void => {
          if (
            outputStarted ||
            !(returnedBody instanceof ReadableStream) ||
            stream.outputCancellation !== undefined
          ) {
            return;
          }
          try {
            void cancelReturnedOutput(stream, returnedBody, reason);
          } catch {
            if (stream.returnedOutput === returnedBody) {
              stream.returnedOutput = undefined;
            }
            // A locked body violates the handler contract and is handled by the
            // existing workload failure path; no cancellable source is owned.
          }
        };
        try {
          const normalized = normalizeHandlerResult(await handler(context));
          returnedBody = normalized.body;
          if (returnedBody instanceof ReadableStream) {
            stream.returnedOutput = returnedBody;
          }
          if (
            stream.abortController.signal.aborted ||
            stream.localTerminal !== undefined
          ) {
            cancelUnstartedOutput(
              stream.abortController.signal.reason ??
                createAbortError("Work aborted"),
            );
            return;
          }
          if (stream.responseMetadataSending !== undefined) {
            await stream.responseMetadataSending;
          }
          if (normalized.metadata !== undefined) {
            if (stream.responseMetadataSent) {
              throw new TypeError(
                "handler returned metadata after sending it explicitly",
              );
            }
            await context.sendMetadata(normalized.metadata);
          } else if (!stream.responseMetadataSent) {
            await context.sendMetadata({});
          }
          if (normalized.body !== undefined) {
            outputStarted = true;
            stream.returnedOutput = undefined;
            await sendBody(stream, normalized.body);
          }
          if (
            stream.abortController.signal.aborted ||
            stream.localTerminal !== undefined
          ) {
            return;
          }
          await sendLocalTerminal(stream, "end");
        } catch (error) {
          cancelUnstartedOutput(error);
          if (
            stream.abortController.signal.aborted &&
            stream.remoteTerminal !== undefined
          ) {
            return;
          }
          abortWork(stream, error);
          try {
            await sendLocalTerminal(stream, "error", error);
          } catch (sendError) {
            failSession(sendError);
          }
        } finally {
          try {
            await stream.outputCancellation;
          } finally {
            reservation?.release();
            if (stream.reservation === reservation) {
              stream.reservation = undefined;
            }
            executionSettlement.resolve(undefined);
            if (stream.executionSettlement === executionSettlement) {
              stream.executionSettlement = undefined;
            }
            if (isCurrentSession() && draining) {
              void completeDrainIfIdle();
            }
          }
        }
      })();
    };

    const cancelForDeadline = (
      stream: MutableStream,
      reason = "deadline_exceeded",
    ): void => {
      stream.locallyRejected = true;
      stream.cancelReason = reason;
      const error = createAbortError("Work deadline elapsed");
      abortWork(stream, error);
      releasePreStartReservation(stream);
      void sendLocalTerminal(stream, "cancel").catch(failSession);
    };

    const createStream = (open: WorkOpenFrame): MutableStream => {
      // Assigned after ReadableStream.start captures its controller.
      // deno-lint-ignore prefer-const
      let stream: MutableStream | undefined;
      let inputController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          inputController = controller;
        },
        pull() {
          if (stream !== undefined) scheduleInputCredit(stream);
        },
        cancel() {
          if (stream === undefined) return;
          // This closes only the local request-body consumer. It does not
          // cancel the operation or its response half. Already-credited bytes
          // are validated and discarded when they arrive.
          stream.inputClosed = true;
        },
      }, new ByteLengthQueuingStrategy({ highWaterMark: inputBufferBytes }));
      const created: MutableStream = {
        open,
        started: false,
        executionStarted: false,
        locallyRejected: false,
        responseMetadataSent: false,
        abortController: new AbortController(),
        input,
        inputController,
        inputClosed: false,
        outstandingInputCredit: 0,
        creditGrantRunning: false,
        sendCredit: 0,
        creditWaiters: new Set(),
        nextSendSequence: 0,
      };
      stream = created;
      return created;
    };

    function completeDrainIfIdle(): Promise<void> {
      if (
        !isCurrentSession() ||
        !draining ||
        streams.size > 0 ||
        executionLedger.occupied() > 0 ||
        sessionConnectionId === undefined ||
        transport === undefined
      ) {
        return Promise.resolve();
      }
      if (rotationRequested && !drainRequestedByPeer) {
        return transport.close({
          code: 1000,
          reason: "resume_rotation",
        });
      }
      if (drainedFrameQueued || drained) {
        return drainCompletion ?? Promise.resolve();
      }
      if (drainCompletion !== undefined) return drainCompletion;
      const drainTransport = transport;
      const drainConnectionId = sessionConnectionId;
      // Fence heartbeat production before Drained enters the serialized send
      // queue. A heartbeat whose metadata callback is already pending must not
      // enqueue behind Drained and violate the terminal protocol phase.
      drainedFrameQueued = true;
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      drainCompletion = drainTransport.sendControl(
        createDrainedFrame({ connectionId: drainConnectionId }),
      ).then(() => {
        drained = true;
        setSessionState("drained");
      }).catch(failSession);
      return drainCompletion;
    }

    const handleControl = async (
      message: Extract<WebSocketTransportMessage, { kind: "control" }>,
    ): Promise<void> => {
      if (
        stopController.signal.aborted ||
        sessionAbortController.signal.aborted
      ) {
        return;
      }
      const { frame, disposition } = message.acceptance;
      switch (frame.type) {
        case "work.open": {
          const stream = createStream(frame);
          streams.set(frame.streamId, stream);
          syncActiveStreams();
          if (draining) {
            cancelForDeadline(stream, "worker_draining");
            return;
          }
          if (
            frame.deadlineAtMs !== undefined &&
            frame.deadlineAtMs <= now()
          ) {
            cancelForDeadline(stream);
            return;
          }
          if (frame.deadlineAtMs !== undefined) {
            stream.cancelDeadline = createAbsoluteTimer(
              frame.deadlineAtMs,
              now,
              () => cancelForDeadline(stream),
            );
          }
          const reservation = executionLedger.reserve();
          if (reservation === undefined) {
            cancelForDeadline(stream, "worker_capacity");
            return;
          }
          stream.reservation = reservation;
          try {
            await transport?.sendControl(
              createWorkAcceptedFrame({ streamId: frame.streamId }),
            );
          } catch (error) {
            if (
              !isProtocolViolation(error) ||
              (error.code !== "post_terminal_frame" &&
                error.code !== "unknown_stream")
            ) {
              throw error;
            }
            // The peer's pre-Start abort crossed this queued acceptance. Its
            // inbound Cancel/Error remains queued for stream-local handling
            // and acknowledgement; it must not fail the multiplexed session.
            stream.locallyRejected = true;
            stream.cancelDeadline?.();
            stream.cancelDeadline = undefined;
            releasePreStartReservation(stream);
          }
          break;
        }

        case "work.start": {
          const stream = streams.get(frame.streamId);
          if (
            stream === undefined ||
            disposition === "discard" ||
            stream.locallyRejected
          ) {
            return;
          }
          stream.started = true;
          scheduleInputCredit(stream);
          invokeHandler(stream);
          break;
        }

        case "work.credit": {
          const stream = streams.get(frame.streamId);
          if (stream === undefined || disposition === "discard") return;
          stream.sendCredit += frame.bytes;
          wakeCreditWaiters(stream);
          break;
        }

        case "work.end": {
          const stream = streams.get(frame.streamId);
          if (stream === undefined) return;
          stream.remoteTerminal = "end";
          if (disposition === "deliver") {
            closeInput(stream);
          }
          finishStreamIfTerminal(stream);
          break;
        }

        case "work.cancel":
        case "work.error": {
          const stream = streams.get(frame.streamId);
          if (stream === undefined) {
            if (disposition === "discard") {
              await transport?.sendControl(
                createWorkCancelFrame({
                  streamId: frame.streamId,
                  reason: "late_abort_ack",
                }),
              );
            }
            return;
          }
          const remoteTerminal = frame.type === "work.cancel"
            ? "cancel"
            : "error";
          stream.remoteTerminal = remoteTerminal;
          if (disposition === "deliver") {
            const error = frame.type === "work.cancel"
              ? createAbortError(frame.reason)
              : new Error(frame.message);
            abortWork(stream, error);
          }
          if (!terminalIsAbort(stream.localTerminal)) {
            void sendLocalTerminal(
              stream,
              remoteTerminal,
              frame.type ===
                  "work.error"
                ? new Error(frame.message)
                : undefined,
            ).catch(failSession);
          }
          finishStreamIfTerminal(stream);
          break;
        }

        case "drain": {
          draining = true;
          drainRequestedByPeer = true;
          setSessionState("draining");
          if (heartbeatTimer !== undefined) {
            // Heartbeats remain legal while draining, so keep it until drained.
          }
          cancelDrainDeadline = createAbsoluteTimer(
            frame.deadlineAtMs,
            now,
            () => {
              for (const stream of streams.values()) {
                cancelForDeadline(stream, "drain_deadline");
              }
              void transport?.close({
                code: 1000,
                reason: DRAIN_CLOSE_REASON,
              }).catch(() => undefined);
            },
          );
          await completeDrainIfIdle();
          break;
        }

        case "shutdown": {
          shutdown = true;
          if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
          for (const stream of streams.values()) {
            abortWork(
              stream,
              createAbortError(`Worker shutdown: ${frame.reason}`),
            );
            releasePreStartReservation(stream);
          }
          streams.clear();
          syncActiveStreams();
          await transport?.close({ code: 1000, reason: "worker_shutdown" });
          break;
        }

        case "protocol_error": {
          failSession(
            createWorkerClientError(
              "invalid_server_message",
              `Hypervisor protocol error: ${frame.code}`,
            ),
          );
          break;
        }

        default:
          // Welcome is consumed by the handshake. All worker-originated frame
          // types are rejected by the protocol validator before this point.
          failSession(
            createWorkerClientError(
              "invalid_server_message",
              `Unexpected server frame ${frame.type}`,
            ),
          );
      }
    };

    const handleData = (
      message: Extract<WebSocketTransportMessage, { kind: "data" }>,
    ): void => {
      if (
        stopController.signal.aborted ||
        sessionAbortController.signal.aborted
      ) {
        return;
      }
      const { frame, disposition } = message.acceptance;
      const stream = streams.get(frame.streamId);
      if (stream === undefined) return;
      stream.outstandingInputCredit -= frame.payload.byteLength;
      if (stream.outstandingInputCredit < 0) {
        failSession(
          createWorkerClientError(
            "invalid_server_message",
            "Input credit accounting became negative",
          ),
        );
        return;
      }
      if (disposition === "deliver" && !stream.inputClosed) {
        try {
          stream.inputController?.enqueue(frame.payload);
        } catch (error) {
          abortWork(stream, error);
          void sendLocalTerminal(stream, "cancel").catch(failSession);
        }
      }
      scheduleInputCredit(stream);
    };

    const heartbeat = async (
      welcome: WelcomeFrame,
    ): Promise<void> => {
      if (
        heartbeatRunning ||
        drainedFrameQueued ||
        drained ||
        shutdown ||
        sessionAbortController.signal.aborted ||
        !isCurrentSession() ||
        transport === undefined
      ) {
        return;
      }
      heartbeatRunning = true;
      try {
        const effectiveInflight = Math.max(
          streams.size,
          executionLedger.occupied(),
        );
        const availableCapacity = draining
          ? 0
          : Math.max(0, capacity - effectiveInflight);
        let metadata: JsonObject | void = undefined;
        if (options.createHeartbeatMetadata !== undefined) {
          const context: WorkerHeartbeatContext = Object.freeze({
            identity,
            connectionId: welcome.connectionId,
            capacity,
            sequence: heartbeatSequence,
            inflight: effectiveInflight,
            availableCapacity,
            draining,
            signal: sessionAbortController.signal,
          });
          const task = Promise.resolve().then(() =>
            options.createHeartbeatMetadata!(context)
          );
          const pending = Object.freeze({ task });
          pendingHeartbeatMetadata = pending;
          task.then(
            () => {
              if (pendingHeartbeatMetadata === pending) {
                pendingHeartbeatMetadata = undefined;
              }
            },
            () => {
              if (pendingHeartbeatMetadata === pending) {
                pendingHeartbeatMetadata = undefined;
              }
            },
          );
          metadata = await waitForTaskOrStop(
            task,
            sessionAbortController.signal,
          );
        }
        if (
          drainedFrameQueued ||
          drained ||
          shutdown ||
          sessionAbortController.signal.aborted ||
          !isCurrentSession() ||
          transport === undefined
        ) {
          return;
        }
        await transport.sendControl(createHeartbeatFrame({
          connectionId: welcome.connectionId,
          sequence: heartbeatSequence,
          inflight: effectiveInflight,
          availableCapacity,
          metadata: metadata ?? {},
        }));
        heartbeatSequence++;
      } catch (error) {
        if (
          !shutdown &&
          !drainedFrameQueued &&
          !drained &&
          !stopController.signal.aborted
        ) {
          failSession(error);
        }
      } finally {
        heartbeatRunning = false;
      }
    };

    try {
      setSessionState("connecting");
      socket = await connectWorkerWebSocket({
        url: options.url,
        signal: stopController.signal,
        ...(options.connectTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.connectTimeoutMs }),
        ...(options.allowInsecureLoopback === undefined
          ? {}
          : { allowInsecureLoopback: options.allowInsecureLoopback }),
        ...(options.createWebSocket === undefined
          ? {}
          : { createWebSocket: options.createWebSocket }),
      });
      transport = await createWebSocketTransport({
        socket,
        role: "worker",
        signal: stopController.signal,
        ...options.transport,
      });
      transport.closed.then((close) => {
        abortSession(
          createWorkerClientError(
            "connection_lost",
            `Worker WebSocket closed (${close.code}: ${close.reason})`,
          ),
        );
      });
      setSessionState("handshaking");
      const iterator = transport.messages()[Symbol.asyncIterator]();
      await transport.sendControl(createHelloFrame({
        handshakeId: handshakeAtHello,
        identity,
        credential: credentialAtHello,
        workloads: workloadNames,
        capacity,
      }));

      const first = await takeWithTimeout(
        iterator,
        handshakeTimeoutMs,
        stopController.signal,
      );
      if (
        !first.done &&
        first.value.kind === "control" &&
        first.value.acceptance.frame.type === "protocol_error"
      ) {
        const protocolError = first.value.acceptance.frame;
        if (PERMANENT_AUTH_ERROR_CODES.has(protocolError.code)) {
          throw createWorkerClientError(
            "credential_rejected",
            `Worker credential requires re-enrollment: ${protocolError.code}`,
          );
        }
        throw createWorkerClientError(
          "handshake_failed",
          `Hypervisor rejected worker handshake: ${protocolError.code}`,
        );
      }
      if (
        first.done ||
        first.value.kind !== "control" ||
        first.value.acceptance.frame.type !== "welcome"
      ) {
        throw createWorkerClientError(
          "handshake_failed",
          "Hypervisor did not send Welcome as its first frame",
        );
      }
      const welcome = first.value.acceptance.frame;
      welcomed = true;
      if (welcome.resumeExpiresAtMs <= now()) {
        throw createWorkerClientError(
          "credential_expired",
          "Hypervisor issued an already-expired resume credential",
        );
      }

      await credentials.acceptWelcome(
        welcome,
        {
          credential: credentialAtHello,
          handshakeId: handshakeAtHello,
        },
        sessionAbortController.signal,
      );
      sessionConnectionId = welcome.connectionId;
      if (isCurrentSession()) connectionId = welcome.connectionId;

      let readyFrame: ReturnType<typeof createReadyFrame>;
      try {
        let metadata: JsonObject | void = undefined;
        if (options.beforeReady !== undefined) {
          const task = Promise.resolve().then(() =>
            options.beforeReady!({
              bootstrap: welcome.bootstrap,
              connectionId: welcome.connectionId,
              signal: sessionAbortController.signal,
              reconnecting: credentialAtHello.kind === "resume",
            })
          );
          const initialization = Object.freeze({ task });
          pendingInitialization = initialization;
          task.then(
            () => {
              if (pendingInitialization === initialization) {
                pendingInitialization = undefined;
              }
            },
            () => {
              if (pendingInitialization === initialization) {
                pendingInitialization = undefined;
              }
            },
          );
          metadata = await runBoundedHandshakeStep(
            "worker pre-ready initialization",
            readyTimeoutMs,
            sessionAbortController.signal,
            () => task,
          );
        }
        readyFrame = createReadyFrame({
          connectionId: welcome.connectionId,
          capacity,
          metadata: metadata ?? {},
        });
      } catch (error) {
        try {
          await transport.sendControl(createProtocolErrorFrame({
            connectionId: welcome.connectionId,
            code: "initialization_failed",
            message: "Worker initialization failed before ready",
          }));
        } catch {
          // Connection failure still prevents Ready and triggers reconnect.
        }
        throw createWorkerClientError(
          "initialization_failed",
          "Worker pre-ready initialization failed",
          error,
        );
      }

      await transport.sendControl(readyFrame);
      const acknowledgement = await takeWithTimeout(
        iterator,
        readyTimeoutMs,
        sessionAbortController.signal,
        "Timed out waiting for Hypervisor Ready acknowledgement",
      );
      if (
        !acknowledgement.done &&
        acknowledgement.value.kind === "control" &&
        acknowledgement.value.acceptance.frame.type === "protocol_error"
      ) {
        const protocolError = acknowledgement.value.acceptance.frame;
        if (PERMANENT_AUTH_ERROR_CODES.has(protocolError.code)) {
          throw createWorkerClientError(
            "credential_rejected",
            `Worker credential requires re-enrollment: ${protocolError.code}`,
          );
        }
        throw createWorkerClientError(
          "handshake_failed",
          `Hypervisor rejected worker readiness: ${protocolError.code}`,
        );
      }
      if (
        acknowledgement.done ||
        acknowledgement.value.kind !== "control" ||
        acknowledgement.value.acceptance.frame.type !== "ready_ack"
      ) {
        throw createWorkerClientError(
          "handshake_failed",
          "Hypervisor did not acknowledge worker readiness",
        );
      }
      if (
        acknowledgement.value.acceptance.frame.connectionId !==
          welcome.connectionId
      ) {
        throw createWorkerClientError(
          "handshake_failed",
          "Hypervisor acknowledged a stale worker connection",
        );
      }
      setSessionState("ready");
      reconnectAttempt = 0;
      if (!everReady) {
        everReady = true;
        readyDeferred.resolve(snapshot());
      }
      void heartbeat(welcome);
      heartbeatTimer = setInterval(
        () => void heartbeat(welcome),
        welcome.heartbeatIntervalMs,
      );
      cancelRotationTimer = createAbsoluteTimer(
        welcome.resumeExpiresAtMs - resumeExpirySkewMs,
        now,
        () => {
          rotationRequested = true;
          draining = true;
          setSessionState("draining");
          cancelRotationDeadline = createAbsoluteTimer(
            welcome.resumeExpiresAtMs,
            now,
            () => {
              void transport?.close({
                code: 1000,
                reason: "resume_expired",
              }).catch(() => undefined);
            },
          );
          void completeDrainIfIdle();
        },
      );

      while (!shutdown) {
        const next = await iterator.next();
        if (next.done) break;
        if (
          stopController.signal.aborted ||
          sessionAbortController.signal.aborted
        ) {
          break;
        }
        if (next.value.kind === "control") {
          await handleControl(next.value);
        } else {
          handleData(next.value);
        }
      }

      if (fatalError !== undefined) throw fatalError;
      if (shutdown) return { reason: "shutdown" };
      if (rotationRequested) return { reason: "rotate" };
      if (draining) return { reason: "drained" };
      const close = await transport.closed;
      return {
        reason: "connection_lost",
        error: createWorkerClientError(
          "connection_lost",
          `Worker WebSocket closed (${close.code}: ${close.reason})`,
        ),
      };
    } catch (error) {
      if (stopController.signal.aborted) throw error;
      return {
        reason: "connection_lost",
        error: isWorkerClientError(error) ? error : createWorkerClientError(
          welcomed ? "connection_lost" : "handshake_failed",
          welcomed ? "Worker connection failed" : "Worker handshake failed",
          error,
        ),
      };
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      cancelRotationTimer?.();
      cancelRotationDeadline?.();
      cancelDrainDeadline?.();
      for (const stream of streams.values()) {
        stream.cancelDeadline?.();
        abortWork(
          stream,
          createWorkerClientError(
            "connection_lost",
            "Work connection was lost; stream will not be replayed",
          ),
        );
        releasePreStartReservation(stream);
      }
      streams.clear();
      syncActiveStreams();
      abortSession(
        createWorkerClientError(
          "connection_lost",
          "Worker session ended",
        ),
      );
      unsubscribeExecutionLedger();
      if (isCurrentSession()) {
        activeStreams = 0;
        connectionId = undefined;
      }
      sessionLease.release();
      if (transport !== undefined) {
        await transport.close({
          code: 1000,
          reason: "worker_session_ended",
          timeoutMs: 1_000,
        }).catch(() => undefined);
      } else if (
        socket !== undefined &&
        socket.readyState !== WebSocket.CLOSED
      ) {
        try {
          socket.close(1000, "worker_session_ended");
        } catch {
          // Best effort for a socket that failed before transport creation.
        }
      }
    }
  };

  const notifyReenrollment = (error: unknown): void => {
    reenrollmentNotifications.publish(error);
  };

  const computeReconnectDelay = (
    context: Parameters<WorkerReconnectDelay>[0],
  ): Promise<number | null> => {
    if (reconnectDelayInvoker === undefined) {
      return Promise.reject(
        new TypeError("reconnect delay is disabled"),
      );
    }
    return reconnectDelayInvoker.run(context);
  };

  const run = async (): Promise<WorkerClientResult> => {
    if (runStarted) {
      throw new TypeError("Worker client run() may only be called once");
    }
    runStarted = true;
    let lastError: unknown = createWorkerClientError(
      "connection_lost",
      "Worker has not connected",
    );
    try {
      while (!stopController.signal.aborted) {
        await settleSerializedWorkBeforeConnect();
        const credentialState = credentials.current();
        if (
          credentialState.credential.kind === "resume" &&
          credentialState.resumeExpiresAtMs !== undefined &&
          credentialState.resumeExpiresAtMs <= now()
        ) {
          const error = createWorkerClientError(
            "credential_expired",
            "Worker resume credential expired; re-enrollment is required",
          );
          notifyReenrollment(error);
          return { reason: "reenrollment_required", error };
        }

        const result = await runSession();
        if (result.reason === "shutdown") {
          return { reason: "shutdown" };
        }
        setState("reconnecting");
        await settleSerializedWorkBeforeConnect();
        if (result.reason === "drained") {
          continue;
        }
        lastError = result.reason === "connection_lost"
          ? result.error
          : createWorkerClientError(
            "connection_lost",
            "Rotating worker resume credential",
          );

        if (
          isWorkerClientError(lastError) &&
          (lastError.code === "credential_expired" ||
            lastError.code === "credential_rejected")
        ) {
          notifyReenrollment(lastError);
          return { reason: "reenrollment_required", error: lastError };
        }
        if (reconnectDelay === false) {
          return { reason: "reconnect_exhausted", error: lastError };
        }
        reconnectAttempt++;
        const reconnectCredentialState = credentials.current();
        const delay = await computeReconnectDelay({
          attempt: reconnectAttempt,
          error: lastError,
          credentialKind: reconnectCredentialState.credential.kind,
          ...(reconnectCredentialState.resumeExpiresAtMs === undefined ? {} : {
            resumeExpiresAtMs: reconnectCredentialState.resumeExpiresAtMs,
          }),
        });
        if (delay === null) {
          return { reason: "reconnect_exhausted", error: lastError };
        }
        if (
          !Number.isSafeInteger(delay) ||
          delay < 0 ||
          delay > maxReconnectDelayMs
        ) {
          throw new TypeError(
            `reconnect delay must be an integer between 0 and ${maxReconnectDelayMs}`,
          );
        }

        const delayCredentialState = credentials.current();
        const safeDelay = delayCredentialState.resumeExpiresAtMs === undefined
          ? delay
          : Math.min(
            delay,
            Math.max(0, delayCredentialState.resumeExpiresAtMs - now()),
          );
        await waitForDelay(safeDelay, stopController.signal);
      }
      return { reason: "stopped" };
    } catch (error) {
      if (!stopController.signal.aborted) throw error;
      return { reason: "stopped" };
    } finally {
      await outputCancellationSettlements.settle();
      runFinished = true;
      setState("stopped");
      options.signal?.removeEventListener("abort", stopFromExternalSignal);
      if (!everReady) {
        readyDeferred.reject(
          isWorkerClientError(lastError) ? lastError : createWorkerClientError(
            "worker_stopped",
            "Worker stopped before becoming ready",
            lastError,
          ),
        );
      }
      runDone.resolve();
    }
  };

  const stop = async (reason = "worker_stopped"): Promise<void> => {
    stopReason = reason;
    const error = createAbortError(reason);
    sessionFence.abortCurrent(error);
    if (!stopController.signal.aborted) {
      stopController.abort(error);
    }
    if (runStarted && !runFinished) await runDone.promise;
    if (!runStarted) {
      setState("stopped");
      readyDeferred.reject(
        createWorkerClientError(
          "worker_stopped",
          `Worker stopped before run: ${stopReason}`,
        ),
      );
    }
  };

  return Object.freeze({
    run,
    whenReady: () => readyDeferred.promise,
    stop,
    snapshot,
  });
}
