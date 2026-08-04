import type { WorkerClientError, WorkerClientErrorCode } from "../types.ts";

export function createWorkerClientError(
  code: WorkerClientErrorCode,
  message: string,
  cause?: unknown,
): WorkerClientError {
  const error = new Error(message) as WorkerClientError;
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    },
    workerClientError: {
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

export function isWorkerClientError(
  value: unknown,
): value is WorkerClientError {
  return value instanceof Error &&
    (value as unknown as { workerClientError?: unknown })
        .workerClientError === true;
}

export function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = message.trim().slice(0, 8_000);
  return bounded.length > 0 ? bounded : "Worker handler failed";
}
