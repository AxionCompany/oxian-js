import { WORKER_PROTOCOL } from "../protocol/index.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  type WorkDispatcher,
} from "../supervisor/index.ts";
import { createHypervisorConfig } from "./config.ts";
import { createAdmissionController } from "./internal/admission.ts";
import { createConnectionEndpoint } from "./internal/connection.ts";
import { createConnectionDirectory } from "./internal/directory.ts";
import { createDispatch } from "./internal/dispatch.ts";
import { createDrainController } from "./internal/drain.ts";
import { createConnectionLifecycleController } from "./internal/lifecycle.ts";
import { createListenerFactory } from "./internal/listener.ts";
import { createSessionProtocolController } from "./internal/session.ts";
import {
  createWorkStreamController,
  type WorkStreamController,
} from "./internal/work-stream.ts";
import type {
  AcceptanceAdmissionState,
  ListenerRecord,
} from "./internal/model.ts";
import {
  createDefaultScheduler,
  NORMAL_CLOSE_CODE,
  validateSessionLifecycle,
} from "./internal/primitives.ts";
import type { Hypervisor, HypervisorOptions } from "./types.ts";

/**
 * Creates the Oxian 0.20 gateway.
 *
 * The returned object is a composable Fetch handler. No listener exists until
 * `listen()` is called, and every worker becomes routable only after authority
 * exchange, Welcome/bootstrap delivery, Ready validation, and process-local
 * session attachment have all succeeded in that order.
 */
export function createHypervisor(
  options: HypervisorOptions,
): Hypervisor {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createHypervisor options are required");
  }
  if (
    options.authority === null ||
    typeof options.authority !== "object" ||
    typeof options.authority.exchange !== "function"
  ) {
    throw new TypeError("authority.exchange must be a function");
  }
  if (
    options.repository === null ||
    typeof options.repository !== "object" ||
    typeof options.repository.getDefinition !== "function"
  ) {
    throw new TypeError("repository.getDefinition must be a function");
  }
  if (typeof options.repository.assertCurrent !== "function") {
    throw new TypeError("repository.assertCurrent must be a function");
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
  const directory = createConnectionDirectory(createConnectionId);
  const records = directory.records;
  const admission = createAdmissionController(config);
  const listeners = new Set<ListenerRecord>();
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

  const fetch = createConnectionEndpoint({
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

  const listen = createListenerFactory({
    isAcceptingConnections: () => acceptingConnections,
    fetch,
    listeners,
  });
  const dispatch = createDispatch({
    dispatcher,
    directory,
    openPending,
  });

  const drain = async (
    workerId: string,
    reason = "requested",
  ): Promise<void> => {
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
      const active = [...records];
      await Promise.allSettled(
        active.map((record) => drainRecord(record, reason, "shutdown")),
      );
      await Promise.allSettled(
        [...records].map(async (record) => {
          if (
            record.transport !== undefined &&
            record.connectionId !== undefined &&
            record.socket.readyState === WebSocket.OPEN
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
      await Promise.allSettled([...listeners].map((entry) => entry.close()));
      lifecycle.stopLeaseSweep();
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
    return Object.freeze({
      acceptingConnections,
      connections: records.size,
      unauthenticatedConnections: admissionSnapshot.unauthenticatedConnections,
      authenticatedConnections: admissionSnapshot.authenticatedConnections,
      handshakeOperations: admissionSnapshot.handshakeOperations,
      readyOperations: admissionSnapshot.readyOperations,
      sessions: sessions.list().length,
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

  return Object.freeze({
    fetch,
    listen,
    dispatch,
    drain,
    shutdownWorker,
    shutdownSession,
    shutdown,
    snapshot,
    config,
    sessions,
  });
}
