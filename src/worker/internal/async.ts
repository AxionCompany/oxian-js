import { createAbortError, createWorkerError } from "./errors.ts";

const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

export function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return Object.freeze({
    promise,
    resolve: (value: T) => resolvePromise?.(value),
    reject: (error: unknown) => rejectPromise?.(error),
  });
}

export function waitForDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? createAbortError("Aborted"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);

    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? createAbortError("Aborted"));
    }

    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createAbsoluteTimer(
  deadlineAtMs: number,
  now: () => number,
  callback: () => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = (): void => {
    if (cancelled) return;
    const remaining = deadlineAtMs - now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(arm, Math.min(MAX_TIMER_DELAY_MS, remaining));
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export function takeWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutMessage = "Timed out waiting for worker Welcome",
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? createAbortError("Aborted"));
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        createWorkerError(
          "handshake_failed",
          timeoutMessage,
        ),
      );
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(signal.reason ?? createAbortError("Aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });

    iterator.next().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function runBoundedHandshakeStep<T>(
  label: string,
  timeoutMs: number,
  signal: AbortSignal,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? createAbortError(`${label} aborted`),
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settleReject(
        new DOMException(`${label} timed out`, "TimeoutError"),
      );
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const settleResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void =>
      settleReject(
        signal.reason ?? createAbortError(`${label} aborted`),
      );
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(operation).then(settleResolve, settleReject);
  });
}

export function waitForTaskOrStop<T>(
  task: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? createAbortError("Worker stopped"));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      cleanup();
      reject(signal.reason ?? createAbortError("Worker stopped"));
    };
    signal.addEventListener("abort", abort, { once: true });
    task.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
