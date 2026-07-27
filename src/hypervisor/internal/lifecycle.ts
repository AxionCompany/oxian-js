import { type ControlFrame, WORKER_PROTOCOL } from "../../protocol/index.ts";
import type {
  SessionRegistry,
  WorkDispatcher,
} from "../../supervisor/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  HypervisorDisconnectReason,
  HypervisorScheduler,
  HypervisorSessionLifecycle,
} from "../types.ts";
import type { AdmissionController } from "./admission.ts";
import type { ConnectionDirectory } from "./directory.ts";
import type { CloseRecord, ConnectionRecord } from "./model.ts";
import {
  cancelConnectionTimer,
  createDeferred,
  createHypervisorError,
  POLICY_CLOSE_CODE,
} from "./primitives.ts";
import type { WorkStreamController } from "./work-stream.ts";

export type ConnectionLifecycleController = Readonly<{
  cleanup(record: ConnectionRecord): Promise<void>;
  close: CloseRecord;
  reject(
    record: ConnectionRecord,
    code: string,
    reason: HypervisorDisconnectReason,
    closeCode?: number,
  ): Promise<void>;
  armLeaseSweep(): void;
  stopLeaseSweep(): void;
}>;

/**
 * Owns exactly-once connection teardown and lease fencing.
 *
 * Peer-close observation, local close, and the transport-loop finalizer may all
 * race into `cleanup`; the cached promise makes one path authoritative.
 */
export function createConnectionLifecycleController(
  options: Readonly<{
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    dispatcher: WorkDispatcher;
    directory: ConnectionDirectory;
    admission: AdmissionController;
    sessionLifecycle?: HypervisorSessionLifecycle;
    finishPending: WorkStreamController["finishPending"];
  }>,
): ConnectionLifecycleController {
  const records = options.directory.records;
  let leaseSweepTimer: unknown;
  let leaseSweepArmed = false;

  const cleanup = (
    record: ConnectionRecord,
  ): Promise<void> => {
    if (record.cleanup !== undefined) return record.cleanup;
    const completion = createDeferred<void>();
    record.cleanup = completion.promise;
    try {
      if (record.phase === "closed") {
        completion.resolve(undefined);
        return record.cleanup;
      }
      record.phase = "closed";
      record.acceptingWork = false;
      const disconnectPhase = record.sessionPhase;
      const disconnectReason = record.disconnectReason ?? "peer_closed";
      record.abort.abort(createHypervisorError(
        "connection_lost",
        "worker connection closed",
        { identity: record.hello?.identity },
      ));
      cancelConnectionTimer(options.scheduler, record, "handshakeTimer");
      cancelConnectionTimer(options.scheduler, record, "readyTimer");
      cancelConnectionTimer(options.scheduler, record, "drainTimer");
      cancelConnectionTimer(options.scheduler, record, "ageTimer");
      options.directory.remove(record);
      record.resolveDrain?.();
      record.resolveDrain = undefined;
      options.admission.releaseClosed(record);
      if (record.fence !== undefined) {
        const changed = options.dispatcher.connectionLost(record.fence);
        for (const pending of [...record.pending.values()]) {
          const dispatch = changed.find((candidate) =>
            candidate.operationId === pending.operationId
          );
          if (dispatch === undefined) continue;
          if (
            dispatch.status === "committing" ||
            (dispatch.status === "cancelling" &&
              dispatch.claimedAtMs !== undefined &&
              dispatch.committedAtMs === undefined)
          ) {
            // Acceptance persistence owns the final indeterminate decision.
            continue;
          }
          const code = dispatch.status === "reschedulable"
            ? "reschedulable"
            : "indeterminate";
          options.finishPending(
            pending,
            dispatch,
            createHypervisorError(
              code,
              dispatch.terminal?.message ??
                "worker connection was lost during work",
              {
                identity: pending.fence.identity,
                operationId: pending.operationId,
              },
            ),
          );
        }
        options.sessions.detach(record.fence);
      }
      if (
        record.fence !== undefined &&
        record.definition !== undefined &&
        disconnectPhase !== undefined &&
        options.sessionLifecycle !== undefined
      ) {
        try {
          const observed: unknown = options.sessionLifecycle.onDisconnect(
            Object.freeze({
              fence: record.fence,
              definition: record.definition,
              phase: disconnectPhase,
              reason: disconnectReason,
              ...(record.peerClose === undefined
                ? {}
                : { peerClose: record.peerClose }),
              disconnectedAtMs: options.clock(),
            }),
          );
          if (
            observed !== null &&
            typeof observed === "object" &&
            "then" in observed &&
            typeof observed.then === "function"
          ) {
            Promise.resolve(observed).catch(() => undefined);
          }
        } catch {
          // A nonblocking observer never owns connection cleanup.
        }
      }
      completion.resolve(undefined);
    } catch (error) {
      completion.reject(error);
    }
    return record.cleanup;
  };

  const close: CloseRecord = async (
    record,
    code,
    wireReason,
    disconnectReason,
  ) => {
    record.disconnectReason ??= disconnectReason;
    const transport = record.transport;
    if (
      record.socket.readyState === WebSocket.CONNECTING ||
      record.socket.readyState === WebSocket.OPEN
    ) {
      try {
        record.socket.close(code, wireReason);
      } catch {
        // The cleanup path below remains authoritative.
      }
    }
    // Cleanup fences and aborts in this turn before waiting for the handshake.
    const cleanupTask = cleanup(record);
    await transport?.close({ code, reason: wireReason }).catch(() => undefined);
    await cleanupTask;
  };

  const reject: ConnectionLifecycleController["reject"] = async (
    record,
    code,
    disconnectReason,
    closeCode = POLICY_CLOSE_CODE,
  ) => {
    if (
      record.transport !== undefined &&
      record.socket.readyState === WebSocket.OPEN
    ) {
      const frame: ControlFrame = {
        protocol: WORKER_PROTOCOL,
        type: "protocol_error",
        ...(record.connectionId === undefined
          ? {}
          : { connectionId: record.connectionId }),
        code,
        message: `Worker connection rejected: ${code}`,
      };
      await record.transport.sendControl(frame).catch(() => undefined);
    }
    await close(record, closeCode, code, disconnectReason);
  };

  const armLeaseSweep = (): void => {
    if (leaseSweepArmed || records.size === 0) return;
    leaseSweepArmed = true;
    const sweep = (): void => {
      leaseSweepArmed = false;
      leaseSweepTimer = undefined;
      for (const expired of options.sessions.expireLeases()) {
        const record = options.directory.get(expired.connectionId);
        if (
          record !== undefined &&
          record.connectionId === expired.connectionId &&
          record.fence?.connectionId === expired.connectionId &&
          record.fence.sessionGeneration === expired.sessionGeneration &&
          record.exchange?.sessionGeneration === expired.sessionGeneration &&
          record.fence.identity.workerId === expired.identity.workerId &&
          record.fence.identity.attemptId === expired.identity.attemptId &&
          record.fence.identity.epoch === expired.identity.epoch
        ) {
          record.sessionPhase = "expired";
          void close(
            record,
            POLICY_CLOSE_CODE,
            "lease_expired",
            "lease_expired",
          );
        }
      }
      // Also fence records when another registry observer consumed the event.
      for (const record of records) {
        if (
          record.fence !== undefined &&
          record.phase === "ready" &&
          !options.sessions.isCurrent(record.fence)
        ) {
          void close(
            record,
            POLICY_CLOSE_CODE,
            "stale_session",
            "stale_session",
          );
        }
      }
      if (records.size > 0) {
        leaseSweepTimer = options.scheduler.schedule(
          sweep,
          options.config.leaseSweepIntervalMs,
        );
        leaseSweepArmed = true;
      }
    };
    leaseSweepTimer = options.scheduler.schedule(
      sweep,
      options.config.leaseSweepIntervalMs,
    );
  };

  const stopLeaseSweep = (): void => {
    if (!leaseSweepArmed || leaseSweepTimer === undefined) return;
    options.scheduler.cancel(leaseSweepTimer);
    leaseSweepArmed = false;
    leaseSweepTimer = undefined;
  };

  return Object.freeze({
    cleanup,
    close,
    reject,
    armLeaseSweep,
    stopLeaseSweep,
  });
}
