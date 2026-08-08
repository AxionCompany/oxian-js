import type { WorkerError, WorkerErrorCode } from "../types.ts";

export function createWorkerError(
  code: WorkerErrorCode,
  message: string,
  cause?: unknown,
): WorkerError {
  const error = new Error(message) as WorkerError;
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    },
    workerError: {
      configurable: false,
      enumerable: true,
      value: true,
      writable: false,
    },
    ...(cause === undefined ? {} : {
      cause: {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      },
    }),
  });
  return error;
}

export function isWorkerError(
  value: unknown,
): value is WorkerError {
  return value instanceof Error &&
    (value as unknown as { workerError?: unknown })
        .workerError === true;
}

export function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.trim().slice(0, 8_000);
  return bounded.length > 0 ? bounded : "Worker handler failed";
}
