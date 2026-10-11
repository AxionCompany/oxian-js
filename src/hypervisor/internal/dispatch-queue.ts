import type {
  SessionRegistry,
  WorkDispatch,
  WorkerSession,
} from "../../supervisor/index.ts";
import type { WorkInput } from "../../work/types.ts";
import type { HypervisorConfig } from "../config.ts";
import type { HypervisorScheduler, HypervisorSnapshot } from "../types.ts";
import { createHypervisorError } from "./primitives.ts";

export type QueueAttempt = Readonly<{
  signal: AbortSignal;
  callbackAttempt: number;
  assertActive(): void;
  offered(dispatch: WorkDispatch): void;
}>;

type Entry = {
  input: WorkInput;
  expiresAtMs: number;
  abort: AbortController;
  selecting: boolean;
  attempts: number;
  timer?: unknown;
  onAbort(): void;
  offer(
    context: QueueAttempt,
  ): WorkDispatch | undefined | Promise<WorkDispatch | undefined>;
  resolve(value: WorkDispatch): void;
  reject(error: unknown): void;
};

/** Only unoffered intent lives here. No protocol retry or acceptance state. */
export function createDispatchQueue(
  options: Readonly<{
    config: HypervisorConfig;
    sessions: SessionRegistry;
    scheduler: HypervisorScheduler;
    clock(): number;
    signal: AbortSignal;
  }>,
) {
  const entries = new Set<Entry>();
  let scheduled = false;
  let pollTimer: unknown;

  const remove = (entry: Entry): boolean => {
    if (!entries.delete(entry)) return false;
    if (entry.timer !== undefined) options.scheduler.cancel(entry.timer);
    entry.input.signal?.removeEventListener("abort", entry.onAbort);
    if (entries.size === 0 && pollTimer !== undefined) {
      options.scheduler.cancel(pollTimer);
      pollTimer = undefined;
    }
    wake();
    return true;
  };
  const reject = (entry: Entry, error: unknown): void => {
    if (!remove(entry)) return;
    entry.abort.abort(error);
    entry.reject(error);
  };
  const assertActive = (entry: Entry): void => {
    entry.abort.signal.throwIfAborted();
    if (options.signal.aborted) {
      throw createHypervisorError(
        "shutting_down",
        "Hypervisor is shutting down",
      );
    }
    if (entry.input.signal?.aborted) {
      throw createHypervisorError(
        "dispatch_aborted",
        "dispatch aborted before offer",
        {
          cause: entry.input.signal.reason,
        },
      );
    }
    if (options.clock() >= entry.expiresAtMs) {
      throw createHypervisorError(
        "deadline_exceeded",
        "dispatch queue deadline elapsed",
      );
    }
    const target = entry.input.target;
    const phase = target === undefined
      ? undefined
      : options.sessions.get(target.workerId)?.phase;
    if (phase === "draining" || phase === "drained") {
      throw createHypervisorError(
        "worker_draining",
        "target Worker is draining",
      );
    }
  };
  const armDeadline = (entry: Entry): void => {
    const remaining = entry.expiresAtMs - options.clock();
    if (remaining <= 0) {
      reject(
        entry,
        createHypervisorError(
          "deadline_exceeded",
          "dispatch queue deadline elapsed",
        ),
      );
      return;
    }
    entry.timer = options.scheduler.schedule(
      () => armDeadline(entry),
      Math.min(remaining, 0x7fff_ffff),
    );
  };
  const settle = (entry: Entry, offered: WorkDispatch | undefined): void => {
    entry.selecting = false;
    if (offered !== undefined && remove(entry)) entry.resolve(offered);
    // A capacity race needs another pass, but empty availability is retried
    // only on a registry event (or the custom-registry polling fallback).
  };
  const pump = (): void => {
    const blockedWorkloads = new Set<string>();
    const blockedTargets = new Set<string>();
    for (const entry of entries) {
      try {
        assertActive(entry);
        const target = entry.input.target?.workerId;
        // Explicit targets have independent lanes even when they expose the
        // same workload. Untargeted requests use a separate workload lane.
        // Runnable lane heads compete in arrival order for actual reservations;
        // an unavailable head never blocks a different lane.
        const blocked = target === undefined
          ? blockedWorkloads.has(entry.input.workload)
          : blockedTargets.has(target);
        if (!entry.selecting && !blocked) {
          const hasRoom = (session: WorkerSession): boolean =>
            session.phase === "ready" && session.reserved < session.capacity &&
            session.workloads.includes(entry.input.workload);
          // Every registry change (including heartbeats) re-runs this pass, so
          // a targeted entry looks up only its own Worker instead of scanning
          // every session: O(entries) per pass rather than O(entries × sessions).
          const available = target === undefined
            ? options.sessions.list().some(hasRoom)
            : (() => {
              const session = options.sessions.get(target);
              return session !== undefined && hasRoom(session);
            })();
          if (available) {
            entry.selecting = true;
            const result = entry.offer({
              signal: entry.abort.signal,
              callbackAttempt: ++entry.attempts,
              assertActive: () => assertActive(entry),
              offered: (dispatch) => settle(entry, dispatch),
            });
            if (result instanceof Promise) {
              void result.then((offered) => {
                settle(entry, offered);
                wake();
              }, (error) => reject(entry, error));
            } else {
              settle(entry, result);
            }
          }
        }
        if (entries.has(entry)) {
          if (target === undefined) blockedWorkloads.add(entry.input.workload);
          else blockedTargets.add(target);
        }
      } catch (error) {
        reject(entry, error);
      }
    }
    if (
      entries.size > 0 && options.sessions.subscribe === undefined &&
      pollTimer === undefined
    ) {
      pollTimer = options.scheduler.schedule(() => {
        pollTimer = undefined;
        wake();
      }, 25);
    }
  };
  function wake(): void {
    if (scheduled || options.signal.aborted || entries.size === 0) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }
  const drainWorker = (workerId: string): void => {
    for (const entry of entries) {
      if (entry.input.target?.workerId === workerId) {
        reject(
          entry,
          createHypervisorError("worker_draining", "target Worker is draining"),
        );
      }
    }
  };
  const unsubscribe = options.sessions.subscribe?.((session) => {
    if (session.phase === "draining" || session.phase === "drained") {
      drainWorker(session.identity.workerId);
    }
    wake();
  });
  const shutdown = (): void => {
    unsubscribe?.();
    for (const entry of entries) {
      reject(
        entry,
        createHypervisorError("shutting_down", "Hypervisor is shutting down"),
      );
    }
  };
  options.signal.addEventListener("abort", shutdown, { once: true });

  return Object.freeze({
    drainWorker,
    enqueue(input: WorkInput, offer: Entry["offer"]): Promise<WorkDispatch> {
      return new Promise((resolve, rejectPromise) => {
        const entry: Entry = {
          input,
          expiresAtMs: Math.min(
            input.deadlineAtMs ?? Infinity,
            options.clock() + options.config.dispatchQueueTimeoutMs,
          ),
          abort: new AbortController(),
          selecting: false,
          attempts: 0,
          onAbort() {
            reject(
              entry,
              createHypervisorError(
                "dispatch_aborted",
                "dispatch aborted before offer",
                { cause: input.signal?.reason },
              ),
            );
          },
          offer,
          resolve,
          reject: rejectPromise,
        };
        assertActive(entry);
        if (entries.size >= options.config.maxQueuedDispatches) {
          throw createHypervisorError(
            "dispatch_queue_full",
            "Hypervisor dispatch queue is full",
          );
        }
        entries.add(entry);
        input.signal?.addEventListener("abort", entry.onAbort, { once: true });
        armDeadline(entry);
        pump();
      });
    },
    snapshot(): Pick<
      HypervisorSnapshot,
      "queuedDispatches" | "queuedDispatchesByLane"
    > {
      const lanes = new Map<
        string,
        { workload: string; workerId?: string; count: number }
      >();
      for (const { input } of entries) {
        const key = JSON.stringify([input.workload, input.target?.workerId]);
        const lane = lanes.get(key) ??
          {
            workload: input.workload,
            ...(input.target === undefined
              ? {}
              : { workerId: input.target.workerId }),
            count: 0,
          };
        lane.count++;
        lanes.set(key, lane);
      }
      return {
        queuedDispatches: entries.size,
        queuedDispatchesByLane: Object.freeze(
          [...lanes.values()].map((lane) => Object.freeze(lane)),
        ),
      };
    },
  });
}
