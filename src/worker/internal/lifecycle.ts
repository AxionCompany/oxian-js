import { waitForTaskOrStop } from "./async.ts";
import { createAbortError } from "./errors.ts";

export type SessionFence = Readonly<{
  /**
   * A successor attaches live but not current, so the session it replaces
   * keeps publishing state until the successor is ready and promoted.
   */
  attach(
    abort: (reason: unknown) => void,
    successor?: boolean,
  ): Readonly<{
    /** The one session whose state the Worker publishes. */
    isCurrent(): boolean;
    /** Attached and not yet released; a handed-off session stays live. */
    isLive(): boolean;
    promote(): void;
    release(): void;
  }>;
  hasCurrent(): boolean;
  /** Aborts every live session. */
  abortAll(reason: unknown): void;
  /** Aborts successors that never became ready. */
  abortSuccessors(reason: unknown): void;
}>;

/**
 * Gives each connection attempt a compare-and-set fence. Late work from an
 * old session can observe staleness, but cannot clear or abort its replacement.
 */
export function createSessionFence(): SessionFence {
  type Entry = { abort(reason: unknown): void; promoted: boolean };
  let current: Entry | undefined;
  const live = new Set<Entry>();
  const promote = (entry: Entry): void => {
    current = entry;
    entry.promoted = true;
  };

  return Object.freeze({
    attach: (abort, successor = false) => {
      const entry: Entry = { abort, promoted: false };
      live.add(entry);
      if (!successor || current === undefined) promote(entry);
      return Object.freeze({
        isCurrent: (): boolean => current === entry,
        isLive: (): boolean => live.has(entry),
        promote: (): void => {
          if (live.has(entry)) promote(entry);
        },
        release: (): void => {
          live.delete(entry);
          if (current === entry) current = undefined;
        },
      });
    },
    hasCurrent: (): boolean => current !== undefined,
    abortAll: (reason): void => {
      for (const entry of [...live]) entry.abort(reason);
    },
    abortSuccessors: (reason): void => {
      for (const entry of [...live]) if (!entry.promoted) entry.abort(reason);
    },
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
      void Promise.resolve()
        .then(() => observer?.(value))
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
