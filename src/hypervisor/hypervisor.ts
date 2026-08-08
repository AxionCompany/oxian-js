import { WORKER_PROTOCOL } from "../protocol/index.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  type WorkDispatcher,
} from "../supervisor/index.ts";
import { createHypervisorConfig } from "./config.ts";
import { createAdmissionController } from "./internal/admission.ts";
import { createConnectionAdmission } from "./internal/connection.ts";
import { registerInProcessExecution } from "./internal/bindings.ts";
import { createConnectionDirectory } from "./internal/directory.ts";
import { createDispatch } from "./internal/dispatch.ts";
import { createDrainController } from "./internal/drain.ts";
import { createInProcessExecution } from "./internal/in-process.ts";
import { createConnectionLifecycleController } from "./internal/lifecycle.ts";
import { createSessionProtocolController } from "./internal/session.ts";
import {
  createWorkStreamController,
  type WorkStreamController,
} from "./internal/work-stream.ts";
import type { AcceptanceAdmissionState } from "./internal/model.ts";
import {
  createDefaultScheduler,
  createHypervisorError,
  NORMAL_CLOSE_CODE,
  validateSessionLifecycle,
} from "./internal/primitives.ts";
import type { Hypervisor, HypervisorOptions } from "./types.ts";

/**
 * Creates the transport-neutral Oxian Hypervisor.
 *
 * The returned object is a composable Fetch handler. No listener exists until
 * In-process workers connect by direct object capability. Remote workers become
 * routable only after registered admission, readiness, and session attachment.
 */
export function createHypervisor(
  options: HypervisorOptions,
): Hypervisor {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createHypervisor options are required");
  }
  if (options.admission !== undefined) {
    if (options.admission.type !== "registered") {
      throw new TypeError('admission.type must be "registered"');
    }
    if (typeof options.admission.authority?.exchange !== "function") {
      throw new TypeError("admission.authority.exchange must be a function");
    }
    if (
      typeof options.admission.repository?.getDefinition !== "function" ||
      typeof options.admission.repository?.assertCurrent !== "function"
    ) {
      throw new TypeError(
        "admission.repository must provide getDefinition and assertCurrent",
      );
    }
  }
  if (typeof options.persistAcceptance !== "function") {
    throw new TypeError("persistAcceptance must be a function");
  }
  validateSessionLifecycle(options.sessionLifecycle);
  const config = createHypervisorConfig(options.config);
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? createDefaultScheduler();
  const createConnectionId = options.createConnectionId ??
    (() => crypto.randomUUID());
  const sessions = options.sessions ?? createSessionRegistry({ clock });
  const dispatcher: WorkDispatcher = createWorkDispatcher({
    sessions,
    persistAcceptance: options.persistAcceptance,
    clock,
  });
  const inProcess = createInProcessExecution({
    dispatcher,
    sessions,
    clock,
    scheduler,
    leaseTimeoutMs: config.leaseTimeoutMs,
  });
  const directory = createConnectionDirectory(createConnectionId);
  const records = directory.records;
  const admission = createAdmissionController(config);
  let acceptingConnections = true;
  let shuttingDown: Promise<void> | undefined;
  const acceptanceAdmission: AcceptanceAdmissionState = {
    pending: 0,
    byWorker: new Map(),
  };
  const workStreamBinding: { current?: WorkStreamController } = {};
  const finishPending: WorkStreamController["finishPending"] = (...args) =>
    workStreamBinding.current!.finishPending(...args);
  const lifecycle = createConnectionLifecycleController({
    config,
    clock,
    scheduler,
    sessions,
    dispatcher,
    directory,
    admission,
    sessionLifecycle: options.sessionLifecycle,
    finishPending,
  });
  const cleanupConnection = lifecycle.cleanup;
  const closeRecord = lifecycle.close;
  const rejectRecord = lifecycle.reject;
  const armLeaseSweep = lifecycle.armLeaseSweep;

  const drainController = createDrainController({
    config,
    clock,
    scheduler,
    sessions,
    closeRecord,
  });
  const finishDrain = drainController.finish;
  const drainRecord = drainController.drain;

  const workStreams = createWorkStreamController({
    config,
    clock,
    scheduler,
    sessions,
    dispatcher,
    acceptanceAdmission,
    closeRecord,
    drainRecord,
  });
  workStreamBinding.current = workStreams;
  const handleWorkControl = workStreams.handleControl;
  const handleWorkData = workStreams.handleData;
  const openPending = workStreams.open;

  const sessionProtocol = createSessionProtocolController({
    hypervisor: options,
    config,
    clock,
    scheduler,
    sessions,
    directory,
    admission,
    closeRecord,
    drainRecord,
    finishDrain,
    handleWorkControl,
    rejectRecord,
  });
  const welcome = sessionProtocol.welcome;
  const ready = sessionProtocol.ready;
  const handleReadyFrame = sessionProtocol.handleFrame;

  const prepareRegistered = createConnectionAdmission({
    config,
    clock,
    scheduler,
    sessions,
    directory,
    admission,
    isAcceptingConnections: () => acceptingConnections,
    fallback: options.fallback,
    armLeaseSweep,
    welcome,
    ready,
    handleReadyFrame,
    handleWorkData,
    closeRecord,
    rejectRecord,
    cleanupConnection,
  });

  const dispatch = createDispatch({
    dispatcher,
    open(offered, input) {
      const assignment = offered.assignment!;
      if (inProcess.has(assignment.fence.identity.workerId)) {
        return inProcess.open(offered, input);
      }
      const record = directory.get(assignment.fence.connectionId);
      if (record === undefined) {
        throw createHypervisorError(
          "worker_unavailable",
          "assigned Worker connection is unavailable",
          {
            identity: assignment.fence.identity,
            operationId: offered.operationId,
          },
        );
      }
      return openPending(
        record,
        offered.operationId,
        Object.freeze({
          streamId: assignment.streamId,
          workload: offered.workload,
          metadata: offered.metadata,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: input.deadlineAtMs }),
        }),
        input.signal,
      );
    },
  });

  const prepare: Hypervisor["prepare"] = (request) => {
    if (
      options.admission === undefined &&
      new URL(request.url).pathname === config.workerPath
    ) {
      return Object.freeze({
        kind: "response" as const,
        response: new Response("Remote worker admission is not configured", {
          status: 404,
        }),
      });
    }
    return prepareRegistered(request);
  };

  const drain = async (
    workerId: string,
    reason = "requested",
  ): Promise<void> => {
    if (inProcess.has(workerId)) return await inProcess.drain(workerId);
    const session = sessions.get(workerId);
    if (session === undefined) return;
    const record = directory.get(session.connectionId);
    if (record !== undefined) {
      await drainRecord(record, reason, "rotate");
    }
  };

  const shutdownWorker = async (
    workerId: string,
    reason = "worker_shutdown",
  ): Promise<void> => {
    if (inProcess.has(workerId)) {
      return await inProcess.shutdownWorker(workerId, reason);
    }
    const session = sessions.get(workerId);
    if (session === undefined) return;
    const record = directory.get(session.connectionId);
    if (record !== undefined) {
      await drainRecord(record, reason, "shutdown");
    }
  };

  const shutdownSession = async (
    fence: Parameters<Hypervisor["shutdownSession"]>[0],
    reason = "session_shutdown",
  ): Promise<void> => {
    if (!sessions.isCurrent(fence)) return;
    if (inProcess.has(fence.identity.workerId)) {
      return await inProcess.shutdownWorker(fence.identity.workerId, reason);
    }
    const record = directory.get(fence.connectionId);
    if (
      record?.fence?.identity.workerId !== fence.identity.workerId ||
      record.fence.identity.attemptId !== fence.identity.attemptId ||
      record.fence.identity.epoch !== fence.identity.epoch ||
      record.fence.sessionGeneration !== fence.sessionGeneration ||
      record.fence.connectionId !== fence.connectionId
    ) return;
    await drainRecord(record, reason, "shutdown");
  };

  const shutdown = (
    reason = "hypervisor_shutdown",
  ): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    acceptingConnections = false;
    shuttingDown = (async () => {
      // Close the direct-binding admission gate before any asynchronous remote
      // drain can give a maintenance-reconnecting Worker time to reattach.
      const inProcessShutdown = inProcess.shutdown(reason);
      const active = [...records];
      await Promise.allSettled(
        active.map((record) => drainRecord(record, reason, "shutdown")),
      );
      await Promise.allSettled(
        [...records].map(async (record) => {
          if (
            record.transport !== undefined &&
            record.connectionId !== undefined &&
            record.connection?.state === "open"
          ) {
            await record.transport.sendControl({
              protocol: WORKER_PROTOCOL,
              type: "shutdown",
              connectionId: record.connectionId,
              reason,
            }).catch(() => undefined);
          }
          await closeRecord(
            record,
            NORMAL_CLOSE_CODE,
            "shutdown",
            "shutdown",
          );
        }),
      );
      lifecycle.stopLeaseSweep();
      await inProcessShutdown;
    })();
    return shuttingDown;
  };

  const snapshot: Hypervisor["snapshot"] = () => {
    const admissionSnapshot = admission.snapshot();
    const work = {
      offered: 0,
      claimed: 0,
      committing: 0,
      committed: 0,
      cancelling: 0,
      reschedulable: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      indeterminate: 0,
    };
    for (const operation of dispatcher.list()) work[operation.status]++;
    const localSnapshot = inProcess.snapshot();
    return Object.freeze({
      acceptingConnections,
      connections: records.size,
      unauthenticatedConnections: admissionSnapshot.unauthenticatedConnections,
      authenticatedConnections: admissionSnapshot.authenticatedConnections,
      handshakeOperations: admissionSnapshot.handshakeOperations,
      readyOperations: admissionSnapshot.readyOperations,
      sessions: sessions.list().length,
      inProcessWorkers: localSnapshot.workers,
      pendingAcceptanceCommits: acceptanceAdmission.pending,
      pendingAcceptanceCommitsByWorker: Object.freeze(
        Array.from(
          acceptanceAdmission.byWorker,
          ([workerId, count]) => Object.freeze({ workerId, count }),
        ).sort((left, right) => left.workerId.localeCompare(right.workerId)),
      ),
      work: Object.freeze(work),
    });
  };

  const hypervisor = Object.freeze({
    prepare,
    dispatch,
    drain,
    shutdownWorker,
    shutdownSession,
    shutdown,
    snapshot,
    config,
    sessions,
  });
  registerInProcessExecution(hypervisor, inProcess);
  return hypervisor;
}
