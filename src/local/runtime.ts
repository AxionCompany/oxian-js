import { createConfiguredApplication } from "../app/configured.ts";
import type { Application } from "../app/types.ts";
import { createHttpGateway } from "../http/gateway.ts";
import { createHttpWorkload } from "../http/workload.ts";
import { HTTP_WORKLOAD, type HttpDispatch } from "../http/types.ts";
import { createWorkerHost } from "../host/host.ts";
import type { InProcessWorker, WorkerHost } from "../host/types.ts";
import { createDenoHypervisor } from "../adapters/deno/server.ts";
import type { Hypervisor, HypervisorListener } from "../hypervisor/types.ts";
import type { WorkerCredential, WorkerIdentity } from "../protocol/types.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "../supervisor/index.ts";
import { createWorkerClient } from "../worker/client.ts";
import type { WorkerClient, WorkerClientResult } from "../worker/types.ts";
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
  host?: WorkerHost;
  hypervisor?: Hypervisor;
  listener?: HypervisorListener;
  worker?: WorkerClient;
  workerRun?: Promise<WorkerClientResult>;
};

type PreparedLocalWorker =
  | Readonly<{
    transport: "in-process";
    host: WorkerHost;
    worker: InProcessWorker;
  }>
  | Readonly<{
    transport: "worker-websocket";
    identity: WorkerIdentity;
    credential: WorkerCredential;
  }>;

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

function localRuntimeError(result: WorkerClientResult): Error {
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
    workerTransport !== "worker-websocket"
  ) {
    throw new TypeError(
      'local runtime workerTransport must be "in-process" or "worker-websocket"',
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
    const host = resources.host;
    const listener = resources.listener;
    const worker = resources.worker;
    await Promise.allSettled([
      hypervisor?.shutdown(reason),
      host?.shutdown(reason),
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
        let prepared: PreparedLocalWorker;
        if (workerTransport === "in-process") {
          const host = createWorkerHost({
            persistAcceptance: () => Promise.resolve(),
          });
          resources.host = host;
          prepared = Object.freeze({
            transport: workerTransport,
            host,
            worker: host.attachInProcessWorker({
              workerId,
              workloads: { [HTTP_WORKLOAD]: workload },
              capacity,
              signal: lifecycleAbort.signal,
            }),
          });
          dispatchReference.current = host.dispatch;
        } else {
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
          prepared = Object.freeze({
            transport: workerTransport,
            identity,
            credential: registration.credential,
          });
        }
        const gateway = createHttpGateway({
          dispatch: (input) => {
            const current = dispatchReference.current;
            if (current === undefined) {
              return Promise.reject(
                new Error("local worker host is not initialized"),
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
        const hypervisor = createDenoHypervisor({
          authority,
          repository,
          persistAcceptance: () => Promise.resolve(),
          config: options.config.gateway.hypervisor,
          fallback,
        });
        resources.hypervisor = hypervisor;
        if (prepared.transport === "worker-websocket") {
          dispatchReference.current = hypervisor.dispatch;
        }
        lifecycleAbort.signal.throwIfAborted();

        const listener = hypervisor.listen({
          hostname,
          port,
          signal: lifecycleAbort.signal,
        });
        resources.listener = listener;

        if (prepared.transport === "in-process") {
          lifecycleAbort.signal.throwIfAborted();
          running = Object.freeze({
            workerTransport: prepared.transport,
            listenerUrl: new URL(listener.url.href),
            identity: prepared.worker.identity,
            router,
            application,
            hypervisor,
            host: prepared.host,
            inProcessWorker: prepared.worker,
          });
        } else {
          const outboundUrl = workerUrl(
            listener,
            hypervisor.config.workerPath,
          );
          const worker = createWorkerClient({
            url: outboundUrl,
            identity: prepared.identity,
            credential: prepared.credential,
            credentialPersistence: "ephemeral",
            workloads: { [HTTP_WORKLOAD]: workload },
            capacity,
            signal: lifecycleAbort.signal,
            allowInsecureLoopback: outboundUrl.protocol === "ws:",
          });
          resources.worker = worker;
          const workerRun = worker.run();
          resources.workerRun = workerRun;
          workerRun.then(
            (result) => fail(localRuntimeError(result)),
            fail,
          );

          await worker.whenReady();
          lifecycleAbort.signal.throwIfAborted();
          running = Object.freeze({
            workerTransport: prepared.transport,
            listenerUrl: new URL(listener.url.href),
            workerUrl: new URL(outboundUrl.href),
            identity: prepared.identity,
            router,
            application,
            hypervisor,
            worker,
          });
        }
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
