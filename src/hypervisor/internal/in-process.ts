import { createWorkerIdentity } from "../../protocol/control.ts";
import type { JsonObject } from "../../protocol/types.ts";
import {
  fenceForSession,
  type SessionFence,
  type WorkDispatch,
} from "../../supervisor/index.ts";
import {
  copyJsonObject,
  copyUniqueWorkloads,
  expectIdentifier,
  expectPositiveInteger,
} from "../../supervisor/internal.ts";
import {
  bodyAsStream,
  normalizeHandlerResult,
} from "../../worker/internal/work.ts";
import type { WorkerWorkHandler } from "../../worker/types.ts";
import type { WorkHandle, WorkInput } from "../../work/types.ts";
import type {
  InProcessExecution,
  InProcessExecutionError,
  InProcessExecutionErrorCode,
  InProcessExecutionOptions,
  InProcessExecutionSnapshot,
  InProcessScheduler,
  InProcessWorker,
  InProcessWorkerInput,
  InProcessWorkerSnapshot,
  InProcessWorkerState,
} from "./in-process-types.ts";

const DEFAULT_LEASE_TIMEOUT_MS = 30_000;
const OUTPUT_HIGH_WATER_BYTES = 64 * 1024;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

type InProcessOperation = {
  operationId: string;
  streamId: string;
  fence: SessionFence;
  input: ReadableStream<Uint8Array>;
  inputReader?: ReadableStreamDefaultReader<Uint8Array>;
  outputReader?: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController;
  metadata: Deferred<JsonObject>;
  metadataSettled: boolean;
  started: Deferred<void>;
  startedSettled: boolean;
  completed: Deferred<WorkDispatch>;
  outputWriter: WritableStreamDefaultWriter<Uint8Array>;
  deadlineTimer?: unknown;
  callerSignal?: AbortSignal;
  callerAbort?: () => void;
  settled: boolean;
};

type InProcessEndpoint = {
  identity: ReturnType<typeof createWorkerIdentity>;
  connectionId: string;
  fence: SessionFence;
  workloads: readonly string[];
  handlers: Readonly<Record<string, WorkerWorkHandler>>;
  capacity: number;
  state: InProcessWorkerState;
  active: Map<string, InProcessOperation>;
  emptyWaiters: Set<Deferred<void>>;
  closed: Deferred<Awaited<InProcessWorker["closed"]>>;
  onStateChange?: (state: InProcessWorkerState) => void;
  drainTask?: Promise<void>;
  stopTask?: Promise<void>;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return Object.freeze({ promise, resolve, reject });
}

function createDefaultScheduler(): InProcessScheduler {
  return Object.freeze({
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
) {
  return expectPositiveInteger(value ?? fallback, name);
}

function createInProcessExecutionError(
  code: InProcessExecutionErrorCode,
  message: string,
  details: Readonly<{
    identity?: InProcessEndpoint["identity"];
    operationId?: string;
    cause?: unknown;
  }> = {},
): InProcessExecutionError {
  const error = new Error(message, {
    ...(details.cause === undefined ? {} : { cause: details.cause }),
  }) as InProcessExecutionError;
  Object.defineProperties(error, {
    name: { configurable: true, value: "HypervisorError", writable: true },
    code: { enumerable: true, value: code },
    ...(details.identity === undefined ? {} : {
      identity: { enumerable: true, value: details.identity },
    }),
    ...(details.operationId === undefined ? {} : {
      operationId: { enumerable: true, value: details.operationId },
    }),
  });
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "in-process workload failed";
}

function cancellationReason(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.slice(0, 512);
  }
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message.slice(0, 512);
  }
  return "caller_cancelled";
}

function createOutputBridge(): Readonly<{
  readable: ReadableStream<Uint8Array>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}> {
  const bridge = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: OUTPUT_HIGH_WATER_BYTES }),
    new ByteLengthQueuingStrategy({ highWaterMark: OUTPUT_HIGH_WATER_BYTES }),
  );
  return Object.freeze({
    readable: bridge.readable,
    writer: bridge.writable.getWriter(),
  });
}

function copyHandlers(
  input: Readonly<Record<string, WorkerWorkHandler>>,
): Readonly<{
  handlers: Readonly<Record<string, WorkerWorkHandler>>;
  workloads: readonly string[];
}> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("in-process worker workloads must be an object");
  }
  const workloads = copyUniqueWorkloads(Object.keys(input));
  const handlers: Record<string, WorkerWorkHandler> = {};
  for (const workload of workloads) {
    const handler = input[workload];
    if (typeof handler !== "function") {
      throw new TypeError(`workload ${workload} must be a function`);
    }
    Object.defineProperty(handlers, workload, {
      configurable: false,
      enumerable: true,
      value: handler,
      writable: false,
    });
  }
  return Object.freeze({ handlers: Object.freeze(handlers), workloads });
}

function operationError(
  endpoint: InProcessEndpoint,
  operation: InProcessOperation,
  code: InProcessExecutionErrorCode,
  message: string,
  cause?: unknown,
): InProcessExecutionError {
  return createInProcessExecutionError(code, message, {
    identity: endpoint.identity,
    operationId: operation.operationId,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Creates a transport-independent Hypervisor. In-process workers attach
 * handlers directly while retaining the same offer, claim, durable acceptance,
 * start, cancellation, capacity, and fencing boundaries used by remote workers.
 */
export function createInProcessExecution(
  options: InProcessExecutionOptions,
): InProcessExecution {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Hypervisor options are required");
  }
  if (options.dispatcher === null || typeof options.dispatcher !== "object") {
    throw new TypeError("Hypervisor dispatcher is required");
  }
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? createDefaultScheduler();
  const leaseTimeoutMs = positiveInteger(
    options.leaseTimeoutMs,
    DEFAULT_LEASE_TIMEOUT_MS,
    "leaseTimeoutMs",
  );
  const createConnectionId = options.createConnectionId ??
    (() => crypto.randomUUID());
  const createAttemptId = options.createAttemptId ??
    (() => crypto.randomUUID());
  const sessions = options.sessions;
  const dispatcher = options.dispatcher;
  const endpoints = new Map<string, InProcessEndpoint>();
  const workerEpochs = new Map<string, number>();
  let acceptingWorkers = true;
  let shutdownTask: Promise<void> | undefined;

  const notifyEmpty = (endpoint: InProcessEndpoint): void => {
    if (endpoint.active.size > 0) return;
    for (const waiter of endpoint.emptyWaiters) waiter.resolve();
    endpoint.emptyWaiters.clear();
  };

  const waitForEmpty = (endpoint: InProcessEndpoint): Promise<void> => {
    if (endpoint.active.size === 0) return Promise.resolve();
    const waiter = createDeferred<void>();
    endpoint.emptyWaiters.add(waiter);
    return waiter.promise;
  };

  const transitionEndpoint = (
    endpoint: InProcessEndpoint,
    state: InProcessWorkerState,
  ): void => {
    if (endpoint.state === state) return;
    endpoint.state = state;
    try {
      endpoint.onStateChange?.(state);
    } catch {
      // Lifecycle observers cannot affect worker execution.
    }
  };

  const removeEndpoint = (
    endpoint: InProcessEndpoint,
    result: Awaited<InProcessWorker["closed"]>,
  ): void => {
    sessions.detach(endpoint.fence);
    if (endpoints.get(endpoint.connectionId) === endpoint) {
      endpoints.delete(endpoint.connectionId);
    }
    endpoint.closed.resolve(Object.freeze(result));
  };

  const finishOperation = (
    endpoint: InProcessEndpoint,
    operation: InProcessOperation,
    dispatch: WorkDispatch,
    error?: InProcessExecutionError,
  ): void => {
    if (operation.settled) return;
    operation.settled = true;
    if (operation.deadlineTimer !== undefined) {
      scheduler.cancel(operation.deadlineTimer);
      operation.deadlineTimer = undefined;
    }
    if (
      operation.callerSignal !== undefined &&
      operation.callerAbort !== undefined
    ) {
      operation.callerSignal.removeEventListener(
        "abort",
        operation.callerAbort,
      );
    }
    if (!operation.startedSettled) {
      operation.startedSettled = true;
      operation.started.reject(
        error ?? operationError(
          endpoint,
          operation,
          "work_failed",
          "work ended before execution started",
        ),
      );
    }
    if (!operation.metadataSettled) {
      operation.metadataSettled = true;
      operation.metadata.reject(
        error ?? operationError(
          endpoint,
          operation,
          "work_failed",
          "workload ended without response metadata",
        ),
      );
    }
    if (error === undefined) {
      void operation.outputWriter.close().catch(() => undefined);
    } else {
      void operation.outputWriter.abort(error).catch(() => undefined);
    }
    void operation.inputReader?.cancel(error).catch(() => undefined);
    void operation.outputReader?.cancel(error).catch(() => undefined);
    operation.completed.resolve(dispatch);
    endpoint.active.delete(operation.streamId);
    notifyEmpty(endpoint);
  };

  const currentDispatch = (
    operation: InProcessOperation,
  ): WorkDispatch | undefined => dispatcher.get(operation.operationId);

  const confirmCancelled = (
    endpoint: InProcessEndpoint,
    operation: InProcessOperation,
  ): WorkDispatch => {
    const current = currentDispatch(operation);
    if (current === undefined || current.status !== "cancelling") {
      throw operationError(
        endpoint,
        operation,
        "invalid_state",
        "cancelled work no longer has an active dispatch",
      );
    }
    return dispatcher.confirmCancellation(
      operation.operationId,
      operation.fence,
      operation.streamId,
      current.cancellation,
    );
  };

  const cancelOperation = async (
    endpoint: InProcessEndpoint,
    operation: InProcessOperation,
    reasonInput: unknown,
  ): Promise<WorkDispatch> => {
    if (operation.settled) return await operation.completed.promise;
    const current = currentDispatch(operation);
    if (current === undefined) return await operation.completed.promise;
    if (
      current.status === "completed" ||
      current.status === "cancelled" ||
      current.status === "failed" ||
      current.status === "indeterminate" ||
      current.status === "reschedulable"
    ) {
      return await operation.completed.promise;
    }
    const reason = cancellationReason(reasonInput);
    if (current.status !== "cancelling") {
      dispatcher.cancel(operation.operationId, {
        code: "caller_cancelled",
        message: reason,
      });
    }
    const error = operationError(endpoint, operation, "work_failed", reason);
    operation.abort.abort(error);
    void operation.outputWriter.abort(error).catch(() => undefined);
    void operation.inputReader?.cancel(error).catch(() => undefined);
    void operation.outputReader?.cancel(error).catch(() => undefined);
    return await operation.completed.promise;
  };

  const copyInput = (
    input: Uint8Array | ReadableStream<Uint8Array> | undefined,
    operation: InProcessOperation,
  ): ReadableStream<Uint8Array> => {
    const source = bodyAsStream(input ?? new Uint8Array());
    const reader = source.getReader();
    operation.inputReader = reader;
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array)) {
            const error = new TypeError(
              "work input yielded a non-Uint8Array chunk",
            );
            controller.error(error);
            void reader.cancel(error).catch(() => undefined);
            return;
          }
          controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: OUTPUT_HIGH_WATER_BYTES }),
    );
  };

  const execute = async (
    endpoint: InProcessEndpoint,
    operation: InProcessOperation,
    handler: WorkerWorkHandler,
    workload: string,
    metadata: JsonObject,
  ): Promise<void> => {
    try {
      const claimed = dispatcher.claim(
        operation.operationId,
        operation.fence,
        operation.streamId,
      );
      if (claimed.status === "cancelling") {
        const cancelled = confirmCancelled(endpoint, operation);
        finishOperation(
          endpoint,
          operation,
          cancelled,
          operationError(endpoint, operation, "work_failed", "work cancelled"),
        );
        return;
      }
      const committed = await dispatcher.commitAcceptance(
        operation.operationId,
        operation.fence,
        operation.streamId,
      );
      if (committed.status !== "committed") {
        if (committed.status === "cancelling") {
          const cancelled = confirmCancelled(endpoint, operation);
          finishOperation(
            endpoint,
            operation,
            cancelled,
            operationError(
              endpoint,
              operation,
              "work_failed",
              "work cancelled",
            ),
          );
          return;
        }
        const code = committed.status === "indeterminate"
          ? "indeterminate"
          : "work_failed";
        const terminal = committed.status === "indeterminate"
          ? dispatcher.settlePeerTerminal(
            operation.operationId,
            operation.fence,
            operation.streamId,
            {
              type: "cancel",
              reason: committed.terminal?.message ??
                "acceptance persistence outcome is unknown",
            },
          )
          : committed;
        finishOperation(
          endpoint,
          operation,
          terminal,
          operationError(
            endpoint,
            operation,
            code,
            committed.terminal?.message ?? "work acceptance failed",
          ),
        );
        return;
      }
      if (operation.abort.signal.aborted) {
        const current = dispatcher.cancel(operation.operationId, {
          code: "caller_cancelled",
          message: cancellationReason(operation.abort.signal.reason),
        });
        if (current.status === "cancelling") {
          const cancelled = confirmCancelled(endpoint, operation);
          finishOperation(
            endpoint,
            operation,
            cancelled,
            operationError(
              endpoint,
              operation,
              "work_failed",
              "work cancelled",
            ),
          );
        }
        return;
      }
      operation.startedSettled = true;
      operation.started.resolve();
      let sentMetadata = false;
      const result = normalizeHandlerResult(
        await handler(Object.freeze({
          streamId: operation.streamId,
          workload,
          metadata,
          input: operation.input,
          signal: operation.abort.signal,
          sendMetadata: (value: JsonObject): Promise<void> => {
            if (sentMetadata) {
              return Promise.reject(
                new TypeError(
                  "workload response metadata may only be sent once",
                ),
              );
            }
            const copied = copyJsonObject(value);
            sentMetadata = true;
            operation.metadataSettled = true;
            operation.metadata.resolve(copied);
            return Promise.resolve();
          },
        })),
      );
      if (result.metadata !== undefined) {
        if (sentMetadata) {
          throw new TypeError(
            "workload returned metadata after sending response metadata",
          );
        }
        sentMetadata = true;
        operation.metadataSettled = true;
        operation.metadata.resolve(copyJsonObject(result.metadata));
      }
      if (!sentMetadata) {
        operation.metadataSettled = true;
        operation.metadata.resolve(Object.freeze({}));
      }
      if (result.body !== undefined) {
        const reader = bodyAsStream(result.body).getReader();
        operation.outputReader = reader;
        try {
          while (true) {
            operation.abort.signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            if (!(next.value instanceof Uint8Array)) {
              throw new TypeError(
                "workload output yielded a non-Uint8Array chunk",
              );
            }
            if (next.value.byteLength > 0) {
              await operation.outputWriter.write(next.value);
            }
          }
        } finally {
          operation.outputReader = undefined;
          reader.releaseLock();
        }
      }
      operation.abort.signal.throwIfAborted();
      const completed = dispatcher.complete(
        operation.operationId,
        operation.fence,
        operation.streamId,
      );
      finishOperation(endpoint, operation, completed);
    } catch (cause) {
      const current = currentDispatch(operation);
      if (current?.status === "cancelling") {
        const cancelled = confirmCancelled(endpoint, operation);
        finishOperation(
          endpoint,
          operation,
          cancelled,
          operationError(
            endpoint,
            operation,
            "work_failed",
            current.cancellation?.message ?? "work cancelled",
            cause,
          ),
        );
        return;
      }
      if (current === undefined) return;
      if (current.status === "committed") {
        const failed = dispatcher.fail(
          operation.operationId,
          operation.fence,
          operation.streamId,
          { code: "workload_failed", message: errorMessage(cause) },
        );
        finishOperation(
          endpoint,
          operation,
          failed,
          operationError(
            endpoint,
            operation,
            "work_failed",
            errorMessage(cause),
            cause,
          ),
        );
        return;
      }
      finishOperation(
        endpoint,
        operation,
        current,
        operationError(
          endpoint,
          operation,
          current.status === "indeterminate" ? "indeterminate" : "work_failed",
          errorMessage(cause),
          cause,
        ),
      );
    }
  };

  const openOperation = (
    endpoint: InProcessEndpoint,
    dispatch: WorkDispatch,
    input: WorkInput,
  ): WorkHandle => {
    const assignment = dispatch.assignment!;
    const metadata = createDeferred<JsonObject>();
    const started = createDeferred<void>();
    const completed = createDeferred<WorkDispatch>();
    const output = createOutputBridge();
    const operation: InProcessOperation = {
      operationId: dispatch.operationId,
      streamId: assignment.streamId,
      fence: assignment.fence,
      input: undefined as unknown as ReadableStream<Uint8Array>,
      abort: new AbortController(),
      metadata,
      metadataSettled: false,
      started,
      startedSettled: false,
      completed,
      outputWriter: output.writer,
      settled: false,
    };
    operation.input = copyInput(input.body, operation);
    endpoint.active.set(operation.streamId, operation);

    const cancel = (reason?: string): Promise<WorkDispatch> =>
      cancelOperation(endpoint, operation, reason);
    const reader = output.readable.getReader();
    const readable = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          const cancellation = cancel(cancellationReason(reason));
          await reader.cancel(reason).catch(() => undefined);
          await cancellation;
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: OUTPUT_HIGH_WATER_BYTES }),
    );

    if (input.signal !== undefined) {
      operation.callerSignal = input.signal;
      operation.callerAbort = () => {
        void cancelOperation(endpoint, operation, input.signal?.reason);
      };
      input.signal.addEventListener("abort", operation.callerAbort, {
        once: true,
      });
    }
    if (dispatch.deadlineAtMs !== undefined) {
      operation.deadlineTimer = scheduler.schedule(() => {
        void cancelOperation(endpoint, operation, "work deadline elapsed");
      }, Math.max(0, dispatch.deadlineAtMs - clock()));
    }

    const handler = endpoint.handlers[dispatch.workload];
    queueMicrotask(() => {
      void execute(
        endpoint,
        operation,
        handler,
        dispatch.workload,
        dispatch.metadata,
      );
    });
    return Object.freeze({
      operationId: operation.operationId,
      streamId: operation.streamId,
      metadata: metadata.promise,
      output: readable,
      started: started.promise,
      completed: completed.promise,
      cancel,
    });
  };

  const drainEndpoint = (endpoint: InProcessEndpoint): Promise<void> => {
    if (endpoint.drainTask !== undefined) return endpoint.drainTask;
    if (endpoint.state === "drained" || endpoint.state === "stopped") {
      return Promise.resolve();
    }
    endpoint.drainTask = (async () => {
      if (endpoint.state === "connected") {
        transitionEndpoint(endpoint, "drained");
        removeEndpoint(endpoint, { reason: "drained" });
        return;
      }
      if (endpoint.state === "ready") {
        transitionEndpoint(endpoint, "draining");
        sessions.startDrain(endpoint.fence);
      }
      await waitForEmpty(endpoint);
      if (endpoint.state === "draining") {
        sessions.markDrained(endpoint.fence);
        transitionEndpoint(endpoint, "drained");
        removeEndpoint(endpoint, { reason: "drained" });
      }
    })();
    return endpoint.drainTask;
  };

  const stopEndpoint = (
    endpoint: InProcessEndpoint,
    reason: string,
  ): Promise<void> => {
    if (endpoint.stopTask !== undefined) return endpoint.stopTask;
    if (endpoint.state === "stopped") return Promise.resolve();
    transitionEndpoint(endpoint, "stopping");
    endpoint.stopTask = (async () => {
      await Promise.all(
        [...endpoint.active.values()].map((operation) =>
          cancelOperation(endpoint, operation, reason).then(() => undefined)
        ),
      );
      transitionEndpoint(endpoint, "stopped");
      removeEndpoint(endpoint, { reason: "shutdown", detail: reason });
    })();
    return endpoint.stopTask;
  };

  const attach = (
    input: InProcessWorkerInput,
  ): InProcessWorker => {
    if (!acceptingWorkers) {
      throw createInProcessExecutionError(
        "shutting_down",
        "Hypervisor is not accepting workers",
      );
    }
    if (input === null || typeof input !== "object") {
      throw new TypeError("in-process worker options are required");
    }
    const workerId = expectIdentifier(input.workerId, "workerId");
    if (sessions.get(workerId) !== undefined) {
      throw createInProcessExecutionError(
        "invalid_state",
        `worker ${workerId} is already attached`,
      );
    }
    const { handlers, workloads } = copyHandlers(input.workloads);
    const capacity = expectPositiveInteger(input.capacity ?? 1, "capacity");
    if (
      (input.identity === undefined) !==
        (input.sessionGeneration === undefined)
    ) {
      throw new TypeError(
        "identity and sessionGeneration must be supplied together",
      );
    }
    if (
      input.onStateChange !== undefined &&
      typeof input.onStateChange !== "function"
    ) {
      throw new TypeError("onStateChange must be a function");
    }
    input.signal?.throwIfAborted();
    const priorEpoch = workerEpochs.get(workerId) ?? 0;
    const identity = input.identity === undefined
      ? createWorkerIdentity({
        workerId,
        attemptId: createAttemptId(),
        epoch: priorEpoch + 1,
      })
      : createWorkerIdentity(input.identity);
    if (identity.workerId !== workerId) {
      throw new TypeError("identity.workerId must match workerId");
    }
    const sessionGeneration = expectPositiveInteger(
      input.sessionGeneration ?? 1,
      "sessionGeneration",
    );
    const connectionId = expectIdentifier(
      createConnectionId(),
      "connectionId",
    );
    const attachment = sessions.attach({
      identity,
      connectionId,
      sessionGeneration,
      workloads,
      capacity,
      leaseTimeoutMs,
      liveness: "binding",
    });
    const endpoint: InProcessEndpoint = {
      identity,
      connectionId,
      fence: fenceForSession(attachment.session),
      workloads,
      handlers,
      capacity,
      state: "connected",
      active: new Map(),
      emptyWaiters: new Set(),
      closed: createDeferred<Awaited<InProcessWorker["closed"]>>(),
      ...(input.onStateChange === undefined
        ? {}
        : { onStateChange: input.onStateChange }),
    };
    endpoints.set(connectionId, endpoint);
    workerEpochs.set(workerId, Math.max(priorEpoch, identity.epoch));

    const markReady = (): void => {
      if (endpoint.state !== "connected") {
        throw createInProcessExecutionError(
          "invalid_state",
          `cannot ready an in-process worker in ${endpoint.state} state`,
          { identity: endpoint.identity },
        );
      }
      const ready = sessions.markReady(endpoint.fence);
      endpoint.fence = fenceForSession(ready);
      transitionEndpoint(endpoint, "ready");
    };

    const snapshot = (): InProcessWorkerSnapshot =>
      Object.freeze({
        state: endpoint.state,
        identity: endpoint.identity,
        connectionId: endpoint.connectionId,
        sessionGeneration: endpoint.fence.sessionGeneration,
        workloads: endpoint.workloads,
        capacity: endpoint.capacity,
        activeWork: endpoint.active.size,
      });
    const worker = Object.freeze({
      identity,
      workloads,
      capacity,
      ready: markReady,
      drain: () => drainEndpoint(endpoint),
      shutdown: (reason = "in_process_worker_shutdown") =>
        stopEndpoint(endpoint, reason),
      snapshot,
      closed: endpoint.closed.promise,
    });
    if (input.signal !== undefined) {
      input.signal.addEventListener("abort", () => {
        void stopEndpoint(
          endpoint,
          cancellationReason(input.signal?.reason),
        );
      }, { once: true });
    }
    return worker;
  };

  const open: InProcessExecution["open"] = (offered, input) => {
    const assignment = offered.assignment!;
    const endpoint = endpoints.get(assignment.fence.connectionId);
    if (endpoint !== undefined && endpoint.state === "ready") {
      return openOperation(endpoint, offered, input);
    }
    throw createInProcessExecutionError(
      "worker_unavailable",
      "assigned in-process worker is unavailable",
      {
        identity: assignment.fence.identity,
        operationId: offered.operationId,
      },
    );
  };

  const findEndpoint = (
    workerIdInput: string,
  ): InProcessEndpoint | undefined => {
    const workerId = expectIdentifier(workerIdInput, "workerId");
    const session = sessions.get(workerId);
    return session === undefined
      ? undefined
      : endpoints.get(session.connectionId);
  };

  const has = (workerId: string): boolean =>
    findEndpoint(workerId) !== undefined;

  const drain = (workerId: string): Promise<void> => {
    const endpoint = findEndpoint(workerId);
    return endpoint === undefined ? Promise.resolve() : drainEndpoint(endpoint);
  };

  const shutdownWorker = (workerId: string, reason = "worker_shutdown") => {
    const endpoint = findEndpoint(workerId);
    return endpoint === undefined
      ? Promise.resolve()
      : stopEndpoint(endpoint, reason);
  };

  const shutdown = (reason = "hypervisor_shutdown"): Promise<void> => {
    if (shutdownTask !== undefined) return shutdownTask;
    acceptingWorkers = false;
    shutdownTask = Promise.all(
      [...endpoints.values()].map((endpoint) => stopEndpoint(endpoint, reason)),
    ).then(() => undefined);
    return shutdownTask;
  };

  const snapshot = (): InProcessExecutionSnapshot => {
    return Object.freeze({
      acceptingWorkers,
      workers: endpoints.size,
    });
  };

  return Object.freeze({
    open,
    attach,
    has,
    drain,
    shutdownWorker,
    shutdown,
    snapshot,
    sessions,
  });
}
