import { createConfiguredApplication } from "../app/configured.ts";
import type { Application } from "../app/types.ts";
import { loadConfig } from "../config/config.ts";
import { createHttpWorkload } from "../http/workload.ts";
import { HTTP_WORKLOAD } from "../http/types.ts";
import { createWorker } from "../worker/worker.ts";
import type { Worker, WorkerResult } from "../worker/types.ts";
import { createAtomicResumeCredentialStore } from "./credential_store.ts";
import type {
  AtomicResumeCredentialStore,
  LocalRuntimeState,
  ManifestWorkerRuntime,
  ManifestWorkerRuntimeOptions,
  ManifestWorkerRuntimeRunning,
} from "./types.ts";

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

function workerStoppedError(result: WorkerResult): Error {
  const error = new Error(`worker stopped: ${result.reason}`);
  error.name = "ManifestWorkerRuntimeError";
  if ("error" in result) {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      value: result.error,
    });
  }
  return error;
}

function isLoopbackWebSocket(url: string): boolean {
  return new URL(url).protocol === "ws:";
}

/**
 * Creates a worker daemon lifecycle from an already validated manifest.
 * Construction is side-effect free and registers no process-global signals.
 */
export function createManifestWorkerRuntime(
  options: ManifestWorkerRuntimeOptions,
): ManifestWorkerRuntime {
  if (options === null || typeof options !== "object") {
    throw new TypeError("manifest worker runtime options are required");
  }
  const manifest = options.manifest;
  const lifecycleAbort = new AbortController();
  const finishedDeferred = createDeferred<void>();
  finishedDeferred.promise.catch(() => undefined);

  let state: LocalRuntimeState = "idle";
  let application: Application<unknown> | undefined;
  let worker: Worker | undefined;
  let workerRun: Promise<WorkerResult> | undefined;
  let credentialStore: AtomicResumeCredentialStore | undefined;
  let running: ManifestWorkerRuntimeRunning | undefined;
  let startTask: Promise<ManifestWorkerRuntimeRunning> | undefined;
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
    await worker?.stop(reason).catch(() => undefined);
    await workerRun?.catch(() => undefined);
    await application?.dispose(reason).catch(() => undefined);
    await credentialStore?.close().catch(() => undefined);
  };

  const fail = (error: unknown): void => {
    if (
      stopRequested ||
      state === "stopped" ||
      state === "stopping" ||
      state === "failed"
    ) {
      return;
    }
    state = "failed";
    if (!lifecycleAbort.signal.aborted) {
      lifecycleAbort.abort("worker_runtime_failed");
    }
    void cleanupResources("worker_runtime_failed").finally(() => {
      settleFinished(error);
    });
  };

  const finishWorkerRun = (result: WorkerResult): void => {
    if (stopRequested) return;
    if (result.reason !== "shutdown" && result.reason !== "stopped") {
      fail(workerStoppedError(result));
      return;
    }
    if (state === "starting") {
      fail(workerStoppedError(result));
      return;
    }
    state = "stopping";
    void cleanupResources("worker_server_shutdown").then(() => {
      state = "stopped";
      settleFinished();
    }, fail);
  };

  const start = (): Promise<ManifestWorkerRuntimeRunning> => {
    if (stopRequested || state === "stopped" || state === "failed") {
      return Promise.reject(
        new Error("worker runtime cannot start after it has stopped"),
      );
    }
    if (startTask !== undefined) return startTask;
    state = "starting";
    startTask = (async () => {
      try {
        const config = await loadConfig(manifest.applicationConfig);
        lifecycleAbort.signal.throwIfAborted();
        const configured = await createConfiguredApplication({
          config: config.application,
          signal: lifecycleAbort.signal,
        });
        const { router, application: configuredApplication } = configured;
        if (lifecycleAbort.signal.aborted) {
          await configuredApplication.dispose(
            lifecycleAbort.signal.reason,
          ).catch(() => undefined);
          lifecycleAbort.signal.throwIfAborted();
        }
        application = configuredApplication;
        const workload = createHttpWorkload({ fetch: application.fetch });

        let credential = manifest.credential;
        let handshakeId = manifest.handshakeId;
        let resumeExpiresAtMs = manifest.resumeExpiresAtMs;
        if (manifest.credentialStore.mode === "durable") {
          credentialStore = createAtomicResumeCredentialStore({
            path: manifest.credentialStore.path,
            identity: manifest.identity,
            initialHandshakeId: manifest.handshakeId,
          });
          const stored = await credentialStore.load();
          lifecycleAbort.signal.throwIfAborted();
          if (stored !== undefined) {
            credential = stored.credential;
            handshakeId = stored.handshakeId;
            resumeExpiresAtMs = stored.resumeExpiresAtMs;
          }
        }

        worker = createWorker({
          transport: {
            type: "websocket",
            url: manifest.gatewayUrl,
            allowInsecureLoopback: isLoopbackWebSocket(manifest.gatewayUrl),
          },
          identity: manifest.identity,
          credential,
          handshakeId,
          ...(resumeExpiresAtMs === undefined ? {} : { resumeExpiresAtMs }),
          workloads: { [HTTP_WORKLOAD]: workload },
          capacity: manifest.capacity,
          signal: lifecycleAbort.signal,
          ...(credentialStore === undefined
            ? { credentialPersistence: "ephemeral" as const }
            : {
              credentialPersistence: "durable" as const,
              persistResumeCredential: credentialStore.persist,
            }),
        });
        workerRun = worker.run();
        workerRun.then(
          finishWorkerRun,
          fail,
        );
        await worker.whenReady();
        if (stopRequested || state !== "starting") {
          throw new DOMException(
            "worker runtime stopped during startup",
            "AbortError",
          );
        }
        running = Object.freeze({
          router,
          application,
          worker,
          workerRun,
        });
        state = "running";
        return running;
      } catch (error) {
        if (!stopRequested) state = "failed";
        await cleanupResources(
          stopRequested
            ? "worker_runtime_stopped"
            : "worker_runtime_start_failed",
        );
        if (!stopRequested) settleFinished(error);
        throw error;
      }
    })();
    return startTask;
  };

  const stop = (reason = "worker_runtime_stopped"): Promise<void> => {
    if (stopTask !== undefined) return stopTask;
    stopRequested = true;
    if (state !== "failed") state = "stopping";
    if (!lifecycleAbort.signal.aborted) lifecycleAbort.abort(reason);
    stopTask = (async () => {
      await cleanupResources(reason);
      if (state !== "failed") {
        state = "stopped";
        settleFinished();
      }
    })();
    return stopTask;
  };

  return Object.freeze({
    start,
    stop,
    finished: finishedDeferred.promise,
    snapshot: () =>
      Object.freeze({
        state,
        ...(worker === undefined ? {} : { worker: worker.snapshot() }),
      }),
  });
}
