import { createConfiguredApplication } from "../app/configured.ts";
import type { Application } from "../app/types.ts";
import { createHttpGateway } from "../http/gateway.ts";
import { createHttpWorkload } from "../http/workload.ts";
import { HTTP_WORKLOAD, type HttpDispatch } from "../http/types.ts";
import { serve } from "../adapters/deno/server.ts";
import { createHypervisor } from "../hypervisor/hypervisor.ts";
import type { Hypervisor, HypervisorListener } from "../hypervisor/types.ts";
import type { WorkerCredential, WorkerIdentity } from "../protocol/types.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "../supervisor/index.ts";
import { createWorker } from "../worker/worker.ts";
import type { Worker, WorkerResult } from "../worker/types.ts";
import { composeConfiguredEdge } from "./edge.ts";
import type {
  LocalRuntime,
  LocalRuntimeOptions,
  LocalRuntimeRunning,
  LocalRuntimeSnapshot,
  LocalRuntimeState,
} from "./types.ts";

type RuntimeResources = {
  application?: Application<unknown>;
  hypervisor?: Hypervisor;
  listener?: HypervisorListener;
  worker?: Worker;
  workerRun?: Promise<WorkerResult>;
};

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function workerUrl(listener: HypervisorListener, path: string): URL {
  const url = new URL(path, listener.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function listenerPort(value: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 65_535
  ) {
    throw new TypeError(
      "local runtime listener port must be an integer between 0 and 65535",
    );
  }
  return value;
}

function localRuntimeError(result: WorkerResult): Error {
  const error = new Error(`local worker stopped: ${result.reason}`);
  error.name = "LocalRuntimeWorkerError";
  if ("error" in result) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      value: result.error,
    });
  }
  return error;
}

/**
 * Creates the v0.20 single-process development/server topology. Construction
 * performs no imports, filesystem reads, network binds, or signal registration;
 * `start()` owns all runtime effects and `stop()` is idempotent.
 */
export function createLocalRuntime(
  options: LocalRuntimeOptions,
): LocalRuntime {
  if (options === null || typeof options !== "object") {
    throw new TypeError("local runtime options are required");
  }
  const mode = options.mode ?? "start";
  if (mode !== "start" && mode !== "dev") {
    throw new TypeError('local runtime mode must be "start" or "dev"');
  }
  const hostname = options.listener?.hostname ??
    options.config.gateway.listener.hostname;
  const port = listenerPort(
    options.listener?.port ?? options.config.gateway.listener.port,
  );
  const workerId = options.workerId ?? "oxian-local-http";
  const capacity = options.capacity ?? 1;
  const workerTransport = options.workerTransport ??
    options.config.gateway.workerTransport;
  if (
    workerTransport !== "in-process" &&
    workerTransport !== "websocket"
  ) {
    throw new TypeError(
      'local runtime workerTransport must be "in-process" or "websocket"',
    );
  }
  const resources: RuntimeResources = {};
  const lifecycleAbort = new AbortController();
  const finishedDeferred = createDeferred<void>();
  finishedDeferred.promise.catch(() => undefined);

  let state: LocalRuntimeState = "idle";
  let running: LocalRuntimeRunning | undefined;
  let startTask: Promise<LocalRuntimeRunning> | undefined;
  let stopTask: Promise<void> | undefined;
  let stopRequested = false;
  let finishedSettled = false;

  const settleFinished = (error?: unknown): void => {
    if (finishedSettled) return;
    finishedSettled = true;
    if (error === undefined) finishedDeferred.resolve();
    else finishedDeferred.reject(error);
  };

  const cleanupResources = async (reason: string): Promise<void> => {
    if (!lifecycleAbort.signal.aborted) lifecycleAbort.abort(reason);
    const hypervisor = resources.hypervisor;
    const listener = resources.listener;
    const worker = resources.worker;
    await Promise.allSettled([
      hypervisor?.shutdown(reason),
      listener?.shutdown(),
      worker?.stop(reason),
    ].filter((task): task is Promise<void> => task !== undefined));
    await resources.workerRun?.catch(() => undefined);
    await resources.application?.dispose(reason).catch(() => undefined);
  };

  const fail = (error: unknown): void => {
    if (stopRequested || state === "stopped" || state === "failed") return;
    state = "failed";
    if (!lifecycleAbort.signal.aborted) {
      lifecycleAbort.abort("local_runtime_failed");
    }
    void cleanupResources("local_runtime_failed").finally(() => {
      settleFinished(error);
    });
  };

  const start = (): Promise<LocalRuntimeRunning> => {
    if (stopRequested || state === "stopped" || state === "failed") {
      return Promise.reject(
        new Error("local runtime cannot start after it has stopped"),
      );
    }
    if (startTask !== undefined) return startTask;
    state = "starting";
    startTask = (async () => {
      try {
        const configured = await createConfiguredApplication({
          config: options.config.application,
          signal: lifecycleAbort.signal,
        });
        const { router, application } = configured;
        if (lifecycleAbort.signal.aborted) {
          await application.dispose(lifecycleAbort.signal.reason).catch(
            () => undefined,
          );
          lifecycleAbort.signal.throwIfAborted();
        }
        resources.application = application;
        const workload = createHttpWorkload({ fetch: application.fetch });

        const repository = createInMemoryWorkerRepository();
        const authority = createInMemoryRegistrationAuthority();
        const dispatchReference: { current?: HttpDispatch } = {};
        let remote:
          | Readonly<{
            identity: WorkerIdentity;
            credential: WorkerCredential;
          }>
          | undefined;
        if (workerTransport === "websocket") {
          await repository.define(createWorkerDefinition({
            workerId,
            providerId: "local-attached",
            workloads: [HTTP_WORKLOAD],
            capacity,
          }));
          lifecycleAbort.signal.throwIfAborted();
          const identity = (await repository.activate(workerId)).attempt
            .identity;
          lifecycleAbort.signal.throwIfAborted();
          const registration = await authority.issueRegistration(identity);
          lifecycleAbort.signal.throwIfAborted();
          remote = Object.freeze({
            identity,
            credential: registration.credential,
          });
        }
        const gateway = createHttpGateway({
          dispatch: (input) => {
            const current = dispatchReference.current;
            if (current === undefined) {
              return Promise.reject(
                new Error("local Hypervisor is not initialized"),
              );
            }
            return current(input);
          },
        });
        const fallback = composeConfiguredEdge(
          gateway,
          options.config.gateway.edge,
          mode,
        );
        const hypervisor = createHypervisor({
          ...(remote === undefined ? {} : {
            admission: {
              type: "registered" as const,
              authority,
              repository,
            },
          }),
          persistAcceptance: () => Promise.resolve(),
          config: options.config.gateway.hypervisor,
          fallback,
        });
        resources.hypervisor = hypervisor;
        dispatchReference.current = hypervisor.dispatch;
        lifecycleAbort.signal.throwIfAborted();

        const listener = serve({
          hypervisor,
          hostname,
          port,
          signal: lifecycleAbort.signal,
        });
        resources.listener = listener;

        const outboundUrl = workerTransport === "websocket"
          ? workerUrl(
            listener,
            hypervisor.config.workerPath,
          )
          : undefined;
        const worker = remote === undefined
          ? createWorker({
            id: workerId,
            transport: { type: "in-process", hypervisor },
            workloads: { [HTTP_WORKLOAD]: workload },
            capacity,
            signal: lifecycleAbort.signal,
          })
          : createWorker({
            transport: {
              type: "websocket",
              url: outboundUrl!,
              allowInsecureLoopback: outboundUrl!.protocol === "ws:",
            },
            identity: remote.identity,
            credential: remote.credential,
            credentialPersistence: "ephemeral",
            workloads: { [HTTP_WORKLOAD]: workload },
            capacity,
            signal: lifecycleAbort.signal,
          });
        resources.worker = worker;
        const workerRun = worker.run();
        resources.workerRun = workerRun;
        workerRun.then(
          (result) => fail(localRuntimeError(result)),
          fail,
        );

        const ready = await worker.whenReady();
        lifecycleAbort.signal.throwIfAborted();
        if (ready.identity === undefined) {
          throw new Error("local Worker became ready without an identity");
        }
        running = Object.freeze({
          workerTransport,
          listenerUrl: new URL(listener.url.href),
          ...(outboundUrl === undefined
            ? {}
            : { workerUrl: new URL(outboundUrl.href) }),
          identity: ready.identity,
          router,
          application,
          hypervisor,
          worker,
        });
        state = "running";
        return running;
      } catch (error) {
        if (!stopRequested) state = "failed";
        await cleanupResources(
          stopRequested
            ? "local_runtime_stopped"
            : "local_runtime_start_failed",
        );
        if (!stopRequested) settleFinished(error);
        throw error;
      }
    })();
    return startTask;
  };

  const stop = (reason = "local_runtime_stopped"): Promise<void> => {
    if (stopTask !== undefined) return stopTask;
    stopRequested = true;
    if (state !== "failed") state = "stopping";
    if (!lifecycleAbort.signal.aborted) lifecycleAbort.abort(reason);
    stopTask = (async () => {
      // Do not wait behind startup. Stopping the currently installed worker and
      // listener makes pending readiness fail promptly; post-await startup
      // checkpoints clean any resource that appears after this pass.
      await cleanupResources(reason);
      if (state !== "failed") {
        state = "stopped";
        settleFinished();
      }
    })();
    return stopTask;
  };

  const snapshot = (): LocalRuntimeSnapshot =>
    Object.freeze({
      state,
      ...(running === undefined ? {} : {
        listenerUrl: running.listenerUrl.href,
        ...(running.workerUrl === undefined
          ? {}
          : { workerUrl: running.workerUrl.href }),
        workerTransport: running.workerTransport,
        identity: running.identity,
      }),
    });

  return Object.freeze({
    start,
    stop,
    finished: finishedDeferred.promise,
    snapshot,
  });
}
