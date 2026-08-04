import { WORKER_PROTOCOL } from "../../protocol/index.ts";
import type { SessionRegistry } from "../../supervisor/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type { HypervisorScheduler } from "../types.ts";
import type { CloseRecord, ConnectionRecord, DrainRecord } from "./model.ts";
import {
  assertCurrentFrame,
  NORMAL_CLOSE_CODE,
  POLICY_CLOSE_CODE,
} from "./primitives.ts";

export type DrainController = Readonly<{
  finish(record: ConnectionRecord, reason: string): Promise<void>;
  drain: DrainRecord;
}>;

export function createDrainController(
  options: Readonly<{
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    closeRecord: CloseRecord;
  }>,
): DrainController {
  const cancelTimer = (record: ConnectionRecord): void => {
    if (record.drainTimer === undefined) return;
    options.scheduler.cancel(record.drainTimer);
    record.drainTimer = undefined;
  };

  const finish = async (
    record: ConnectionRecord,
    reason: string,
  ): Promise<void> => {
    if (record.drainFinishing) return;
    record.drainFinishing = true;
    let terminalSent = false;
    if (
      record.drainMode === "shutdown" &&
      record.transport !== undefined &&
      record.connectionId !== undefined &&
      record.connection?.state === "open"
    ) {
      record.disconnectReason ??= "shutdown";
      try {
        await record.transport.sendControl({
          protocol: WORKER_PROTOCOL,
          type: "shutdown",
          connectionId: record.connectionId,
          reason,
        }, { signal: record.abort.signal });
        terminalSent = true;
      } catch {
        // Failed terminal delivery falls through to authoritative cleanup.
      }
    }
    if (terminalSent) {
      // The peer's close handshake acknowledges that it observed Shutdown.
      // Keep the original drain deadline armed: its `drainFinishing` branch
      // force-closes an unresponsive peer without racing a queued terminal
      // frame off the wire.
      await record.transport!.closed;
    }
    cancelTimer(record);
    await options.closeRecord(
      record,
      NORMAL_CLOSE_CODE,
      record.drainMode === "shutdown" ? "shutdown" : "rotate",
      record.drainMode === "shutdown" ? "shutdown" : "rotation",
    );
    record.resolveDrain?.();
    record.resolveDrain = undefined;
  };

  const drain: DrainRecord = (
    record,
    reason,
    mode = "rotate",
    timeoutMs = options.config.shutdownTimeoutMs,
  ) => {
    if (record.drainPromise !== undefined) {
      if (mode === "shutdown") record.drainMode = "shutdown";
      return record.drainPromise;
    }
    if (
      record.phase !== "ready" ||
      record.fence === undefined ||
      record.connectionId === undefined ||
      record.transport === undefined
    ) {
      return Promise.resolve();
    }
    record.acceptingWork = false;
    record.drainMode = mode;
    record.drainPromise = new Promise<void>((resolve) => {
      record.resolveDrain = resolve;
    });
    const deadlineAtMs = options.clock() + timeoutMs;
    record.drainTimer = options.scheduler.schedule(() => {
      record.drainTimer = undefined;
      if (record.drainMode === "shutdown") {
        if (record.drainFinishing) {
          void options.closeRecord(
            record,
            NORMAL_CLOSE_CODE,
            "shutdown_timeout",
            "shutdown_timeout",
          );
          return;
        }
        // Terminal shutdown still emits its explicit protocol frame after the
        // worker misses Drain's deadline. Give that ordered send one bounded
        // grace window; closing aborts a backpressured Drain/Shutdown queue.
        record.drainTimer = options.scheduler.schedule(() => {
          void options.closeRecord(
            record,
            NORMAL_CLOSE_CODE,
            "shutdown_timeout",
            "shutdown_timeout",
          );
        }, Math.max(1, Math.min(1_000, timeoutMs)));
        void finish(record, reason);
      } else {
        void options.closeRecord(
          record,
          NORMAL_CLOSE_CODE,
          "drain_timeout",
          "drain_timeout",
        );
      }
    }, timeoutMs);
    void (async () => {
      try {
        assertCurrentFrame(record, options.sessions);
        options.sessions.startDrain(record.fence!);
        record.sessionPhase = "draining";
        await record.transport!.sendControl({
          protocol: WORKER_PROTOCOL,
          type: "drain",
          connectionId: record.connectionId!,
          reason,
          deadlineAtMs,
        });
      } catch {
        await options.closeRecord(
          record,
          POLICY_CLOSE_CODE,
          "drain_failed",
          "drain_failed",
        );
      }
    })();
    return record.drainPromise;
  };

  return Object.freeze({ finish, drain });
}
