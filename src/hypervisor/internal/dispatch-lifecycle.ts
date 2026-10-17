import type { SessionFence, SessionRegistry } from "../../supervisor/index.ts";
import type { WorkInput } from "../../work/types.ts";
import type { HypervisorConfig } from "../config.ts";
import type { HypervisorScheduler } from "../types.ts";
import { createDeferred, createHypervisorError } from "./primitives.ts";

/** Pre-open deadlines and hook occupancy are separate from execution capacity. */
export function createDispatchLifecycle(
  options: Readonly<{
    config: HypervisorConfig;
    sessions: SessionRegistry;
    scheduler: HypervisorScheduler;
    clock(): number;
    signal: AbortSignal;
  }>,
) {
  let pendingHooks = 0;
  const active = new Set<{
    workerId?: string;
    check(): void;
    cancel(error: Error): void;
  }>();
  const unsubscribe = options.sessions.subscribe?.(() => {
    for (const scope of active) scope.check();
  });
  const shutdown = () => {
    unsubscribe?.();
    for (const scope of active) {
      scope.cancel(
        createHypervisorError("shutting_down", "Hypervisor is shutting down"),
      );
    }
  };
  options.signal.addEventListener("abort", shutdown, { once: true });

  return Object.freeze({
    snapshot: () => pendingHooks,
    drainWorker(workerId: string) {
      for (const scope of active) {
        if (scope.workerId === workerId) {
          scope.cancel(
            createHypervisorError(
              "worker_draining",
              "target Worker is draining",
            ),
          );
        }
      }
    },
    create(input: WorkInput, waits: boolean) {
      const abort = new AbortController();
      const stopped = createDeferred<never>();
      const expiresAtMs = Math.min(
        input.deadlineAtMs ?? Infinity,
        options.clock() + options.config.dispatchQueueTimeoutMs,
      );
      // This private state, not the callback-visible AbortSignal, gates effects.
      let failure: Error | undefined;
      let finished = false;
      let fence: SessionFence | undefined;
      let timer: unknown;
      const cancel = (error: Error) => {
        if (failure !== undefined || finished) return;
        failure = error;
        stopped.reject(error);
        abort.abort(error);
      };
      const check = () => {
        if (failure !== undefined || finished) return;
        if (options.signal.aborted) {
          cancel(
            createHypervisorError(
              "shutting_down",
              "Hypervisor is shutting down",
            ),
          );
        } else if (input.signal?.aborted) {
          cancel(
            createHypervisorError(
              "dispatch_aborted",
              "dispatch aborted before open",
              { cause: input.signal.reason },
            ),
          );
        } else if (options.clock() >= expiresAtMs) {
          cancel(
            createHypervisorError(
              "deadline_exceeded",
              "dispatch deadline elapsed before open",
            ),
          );
        } else if (fence !== undefined && !options.sessions.isCurrent(fence)) {
          cancel(
            createHypervisorError(
              "worker_unavailable",
              "assigned Worker session is no longer current",
            ),
          );
        } else {
          const workerId = fence?.identity.workerId ?? input.target?.workerId;
          const phase =
            workerId === undefined
              ? undefined
              : options.sessions.get(workerId)?.phase;
          if (phase === "draining" || phase === "drained") {
            cancel(
              createHypervisorError(
                "worker_draining",
                "target Worker is draining",
              ),
            );
          }
        }
      };
      const assertActive = () => {
        check();
        if (failure !== undefined) throw failure;
      };
      const scope = { workerId: input.target?.workerId, check, cancel };
      const arm = () => {
        check();
        if (failure === undefined) {
          timer = options.scheduler.schedule(
            arm,
            Math.min(
              expiresAtMs - options.clock(),
              options.sessions.subscribe === undefined ? 25 : Infinity,
            ),
          );
        }
      };
      const dispose = () => {
        active.delete(scope);
        input.signal?.removeEventListener("abort", check);
        if (timer !== undefined) options.scheduler.cancel(timer);
      };
      return Object.freeze({
        signal: abort.signal,
        expiresAtMs,
        assertActive,
        opened() {
          assertActive();
          // The real work handle takes over caller cancellation and deadlines.
          // A pre-open refusal must never race an already delivered WorkOpen.
          finished = true;
          dispose();
        },
        assigned(value: SessionFence) {
          fence = value;
          scope.workerId = value.identity.workerId;
          assertActive();
        },
        async hook<T>(callback: () => T | Promise<T>): Promise<T> {
          assertActive();
          if (pendingHooks >= options.config.maxPendingDispatchHooks) {
            throw createHypervisorError(
              "dispatch_hook_capacity",
              "Hypervisor dispatch hook capacity is full",
            );
          }
          pendingHooks++;
          try {
            return await callback();
          } finally {
            // Timeout/abort does not pretend a noncooperative hook has ended.
            pendingHooks--;
          }
        },
        async run<T>(operation: () => Promise<T>): Promise<T> {
          try {
            active.add(scope);
            input.signal?.addEventListener("abort", check);
            if (waits) arm();
            assertActive();
            return await Promise.race([operation(), stopped.promise]);
          } finally {
            dispose();
          }
        },
      });
    },
  });
}
