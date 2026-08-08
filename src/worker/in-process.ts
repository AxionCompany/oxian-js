import { connectInProcessWorker } from "../hypervisor/internal/bindings.ts";
import type { InProcessWorker as InProcessBinding } from "../hypervisor/internal/in-process-types.ts";
import type { WorkerIdentity } from "../protocol/index.ts";
import { expectPositiveInteger } from "./internal/validation.ts";
import { createDeferred, waitForTaskOrStop } from "./internal/async.ts";
import { createAbortError } from "./internal/errors.ts";
import { createLatestAsyncObserver } from "./internal/lifecycle.ts";
import type {
  InProcessWorkerOptions,
  Worker,
  WorkerResult,
  WorkerSnapshot,
  WorkerState,
} from "./types.ts";

function workerId(value: string): string {
  const id = value?.trim();
  if (!id) throw new TypeError("id must be a non-empty worker identifier");
  return id;
}

/** Direct, same-isolate realization of the Worker lifecycle. */
export function createInProcessWorker(
  options: InProcessWorkerOptions,
): Worker {
  if (options === null || typeof options !== "object") {
    throw new TypeError("worker options are required");
  }
  const id = workerId(options.id);
  const capacity = expectPositiveInteger(options.capacity, "capacity", 1);
  const workloadEntries = Object.entries(options.workloads ?? {});
  if (workloadEntries.length === 0) {
    throw new TypeError("workloads must contain at least one handler");
  }
  if (
    workloadEntries.some(([name, handle]) =>
      name.length === 0 || typeof handle !== "function"
    )
  ) {
    throw new TypeError(
      "every workload must have a non-empty name and handler",
    );
  }
  const workloads = Object.freeze(
    Object.fromEntries(workloadEntries),
  ) as Readonly<Record<string, typeof workloadEntries[number][1]>>;
  if (
    options.beforeReady !== undefined &&
    typeof options.beforeReady !== "function"
  ) {
    throw new TypeError("beforeReady must be a function");
  }
  if (
    options.onStateChange !== undefined &&
    typeof options.onStateChange !== "function"
  ) {
    throw new TypeError("onStateChange must be a function");
  }
  const ready = createDeferred<WorkerSnapshot>();
  ready.promise.catch(() => undefined);
  const settled = createDeferred<WorkerResult>();
  const stateNotifications = createLatestAsyncObserver(options.onStateChange);
  let state: WorkerState = "idle";
  let binding: InProcessBinding | undefined;
  let running: Promise<WorkerResult> | undefined;
  let stopTask: Promise<void> | undefined;
  let stopRequested = false;
  let externalAbort: (() => void) | undefined;
  let identity: WorkerIdentity | undefined;
  let sessionGeneration = 0;
  let pendingInitialization: Promise<unknown> | undefined;
  const lifecycle = new AbortController();

  const snapshot = (): WorkerSnapshot => {
    const current = binding?.snapshot();
    return Object.freeze({
      state,
      transport: "in-process" as const,
      ...(identity === undefined ? {} : { identity }),
      ...(current === undefined ? {} : {
        connectionId: current.connectionId,
      }),
      activeStreams: current?.activeWork ?? 0,
      occupiedExecutions: current?.activeWork ?? 0,
      reconnectAttempt: 0,
    });
  };

  const publish = (next: WorkerState): void => {
    if (state === next) return;
    state = next;
    stateNotifications.publish(snapshot());
  };

  const stop = (reason = "worker_stopped"): Promise<void> => {
    if (stopTask !== undefined) return stopTask;
    stopRequested = true;
    if (!lifecycle.signal.aborted) lifecycle.abort(reason);
    stopTask = (async () => {
      if (binding !== undefined) {
        publish("draining");
        await binding.shutdown(reason);
      }
      publish("stopped");
      settled.resolve(Object.freeze({ reason: "stopped" }));
      ready.reject(createAbortError(reason));
      if (externalAbort !== undefined) {
        options.signal?.removeEventListener("abort", externalAbort);
        externalAbort = undefined;
      }
    })();
    return stopTask;
  };

  if (options.signal !== undefined) {
    if (options.signal.aborted) {
      void stop(String(options.signal.reason ?? "worker_aborted"));
    } else {
      externalAbort = () => {
        void stop(String(options.signal?.reason ?? "worker_aborted"));
      };
      options.signal.addEventListener("abort", externalAbort, { once: true });
    }
  }

  const run = (): Promise<WorkerResult> => {
    if (running !== undefined) return running;
    running = (async () => {
      if (stopRequested) return await settled.promise;
      let reconnecting = false;
      try {
        while (!stopRequested) {
          publish(reconnecting ? "reconnecting" : "connecting");
          const priorInitialization = pendingInitialization;
          if (priorInitialization !== undefined) {
            try {
              await waitForTaskOrStop(
                priorInitialization,
                lifecycle.signal,
              );
            } catch (error) {
              if (lifecycle.signal.aborted) throw error;
              // A failed initializer may retry, but never concurrently.
            }
          }
          const attached: InProcessBinding = connectInProcessWorker(
            options.transport.hypervisor,
            {
              workerId: id,
              ...(identity === undefined
                ? {}
                : { identity, sessionGeneration: sessionGeneration + 1 }),
              workloads,
              capacity,
              onStateChange(next) {
                if (binding !== attached || stopRequested) return;
                if (next === "draining") publish("draining");
                if (next === "drained") publish("drained");
              },
            },
          );
          binding = attached;
          const connected = attached.snapshot();
          identity = connected.identity;
          sessionGeneration = connected.sessionGeneration;

          const sessionLifecycle = new AbortController();
          const stopSession = (): void => {
            if (!sessionLifecycle.signal.aborted) {
              sessionLifecycle.abort(lifecycle.signal.reason);
            }
          };
          lifecycle.signal.addEventListener("abort", stopSession, {
            once: true,
          });
          const closed = attached.closed;

          try {
            if (options.beforeReady !== undefined) {
              publish("handshaking");
              const initialization = Promise.resolve().then(() =>
                options.beforeReady!(Object.freeze({
                  bootstrap: Object.freeze({}),
                  connectionId: connected.connectionId,
                  signal: sessionLifecycle.signal,
                  reconnecting,
                }))
              );
              pendingInitialization = initialization;
              initialization.then(
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
              const outcome = await Promise.race([
                waitForTaskOrStop(
                  initialization,
                  sessionLifecycle.signal,
                ).then(() => Object.freeze({ type: "initialized" as const })),
                closed.then((result) =>
                  Object.freeze({ type: "closed" as const, result })
                ),
              ]);
              if (outcome.type === "closed") {
                if (!sessionLifecycle.signal.aborted) {
                  sessionLifecycle.abort(
                    outcome.result.detail ?? outcome.result.reason,
                  );
                }
                binding = undefined;
                if (stopRequested) return await settled.promise;
                if (outcome.result.reason === "shutdown") {
                  publish("stopped");
                  settled.resolve(Object.freeze({ reason: "shutdown" }));
                  return await settled.promise;
                }
                reconnecting = true;
                continue;
              }
            }
            if (stopRequested) return await settled.promise;
            attached.ready();
            publish("ready");
            ready.resolve(snapshot());

            const result = await closed;
            if (!sessionLifecycle.signal.aborted) {
              sessionLifecycle.abort(result.detail ?? result.reason);
            }
            binding = undefined;
            if (stopRequested) return await settled.promise;
            if (result.reason === "shutdown") {
              publish("stopped");
              settled.resolve(Object.freeze({ reason: "shutdown" }));
              return await settled.promise;
            }
            publish("drained");
            reconnecting = true;
          } finally {
            lifecycle.signal.removeEventListener("abort", stopSession);
          }
        }
        return await settled.promise;
      } catch (error) {
        if (stopRequested) return await settled.promise;
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "shutting_down" &&
          identity !== undefined
        ) {
          publish("stopped");
          settled.resolve(Object.freeze({ reason: "shutdown" }));
          return await settled.promise;
        }
        await binding?.shutdown("worker_initialization_failed").catch(
          () => undefined,
        );
        binding = undefined;
        publish("stopped");
        ready.reject(error);
        throw error;
      } finally {
        if (externalAbort !== undefined) {
          options.signal?.removeEventListener("abort", externalAbort);
          externalAbort = undefined;
        }
      }
    })();
    return running;
  };

  return Object.freeze({
    run,
    whenReady: () => ready.promise,
    stop,
    snapshot,
  });
}
