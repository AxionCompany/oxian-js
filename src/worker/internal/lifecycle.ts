import { waitForTaskOrStop } from "./async.ts";
import { createAbortError } from "./errors.ts";

export type SessionFence = Readonly<{
  attach(abort: (reason: unknown) => void): Readonly<{
    isCurrent(): boolean;
    release(): void;
  }>;
  abortCurrent(reason: unknown): void;
}>;

/**
 * Gives each connection attempt a compare-and-set fence. Late work from an
 * old session can observe staleness, but cannot clear or abort its replacement.
 */
export function createSessionFence(): SessionFence {
  let current:
    | Readonly<{ token: symbol; abort(reason: unknown): void }>
    | undefined;

  return Object.freeze({
    attach: (abort) => {
      const token = Symbol("worker-session");
      current = Object.freeze({ token, abort });
      return Object.freeze({
        isCurrent: (): boolean => current?.token === token,
        release: (): void => {
          if (current?.token === token) current = undefined;
        },
      });
    },
    abortCurrent: (reason): void => current?.abort(reason),
  });
}

export type LatestAsyncObserver<T> = Readonly<{
  publish(value: T): void;
}>;

/**
 * Serializes a best-effort observer and coalesces queued values to the latest.
 * Observer failures and latency never gate the worker lifecycle.
 */
export function createLatestAsyncObserver<T>(
  observer: ((value: T) => void | Promise<void>) | undefined,
): LatestAsyncObserver<T> {
  let running = false;
  let pending: T | undefined;

  const publish = (value: T): void => {
    if (observer === undefined) return;
    pending = value;
    if (running) return;
    running = true;
    void (async () => {
      while (pending !== undefined) {
        const next = pending;
        pending = undefined;
        try {
          await Promise.resolve().then(() => observer(next));
        } catch {
          // Observation is best effort and never owns the worker lifecycle.
        }
      }
    })().finally(() => {
      running = false;
      if (pending !== undefined) publish(pending);
    });
  };

  return Object.freeze({ publish });
}

export type OneShotAsyncObserver<T> = Readonly<{
  publish(value: T): void;
}>;

export function createOneShotAsyncObserver<T>(
  observer: ((value: T) => void | Promise<void>) | undefined,
): OneShotAsyncObserver<T> {
  let published = false;
  return Object.freeze({
    publish: (value): void => {
      if (published) return;
      published = true;
      void Promise.resolve().then(() => observer?.(value))
        .catch(() => undefined);
    },
  });
}

export type SingleFlightInvoker<Input, Output> = Readonly<{
  run(input: Input): Promise<Output>;
}>;

/**
 * Keeps a user callback single-flight and races callers against process stop
 * without pretending the callback's Promise itself can be cancelled.
 */
export function createSingleFlightInvoker<Input, Output>(
  invoke: (input: Input) => Output | Promise<Output>,
  signal: AbortSignal,
): SingleFlightInvoker<Input, Output> {
  let running: Promise<Output> | undefined;

  const run = (input: Input): Promise<Output> => {
    if (running === undefined) {
      const task = Promise.resolve().then(() => {
        if (signal.aborted) {
          throw signal.reason ?? createAbortError("Worker stopped");
        }
        return invoke(input);
      });
      running = task;
      task.then(
        () => {
          if (running === task) running = undefined;
        },
        () => {
          if (running === task) running = undefined;
        },
      );
    }
    return waitForTaskOrStop(running, signal);
  };

  return Object.freeze({ run });
}

export type PendingSettlementTracker = Readonly<{
  track(task: PromiseLike<unknown>): Promise<void>;
  settle(): Promise<void>;
}>;

/**
 * Owns asynchronous cleanup that may outlive one physical connection.
 *
 * Tracked failures are considered settled rather than propagated: the caller
 * that initiated cleanup owns protocol error handling, while this tracker owns
 * only the process-lifetime completion fence.
 */
export function createPendingSettlementTracker(): PendingSettlementTracker {
  const pending = new Set<Promise<void>>();

  const track = (task: PromiseLike<unknown>): Promise<void> => {
    const settlement = Promise.resolve(task).then(
      () => undefined,
      () => undefined,
    );
    pending.add(settlement);
    void settlement.then(() => {
      pending.delete(settlement);
    });
    return settlement;
  };

  const settle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };

  return Object.freeze({ track, settle });
}
