import {
  type ControlFrame,
  type JsonObject,
  WORKER_PROTOCOL,
} from "../../protocol/index.ts";
import type {
  SessionRegistry,
  WorkDispatch,
  WorkDispatcher,
} from "../../supervisor/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  HypervisorError,
  HypervisorErrorCode,
  HypervisorScheduler,
} from "../types.ts";
import type { WorkHandle } from "../../work/types.ts";
import type {
  AcceptanceAdmissionState,
  CloseRecord,
  ConnectionRecord,
  DrainRecord,
  PendingOpenInput,
  PendingWork,
} from "./model.ts";
import {
  assertCurrentFrame,
  createDeferred,
  createHypervisorError,
  errorCode,
  INTERNAL_CLOSE_CODE,
  MAX_TIMER_MS,
  OUTPUT_WINDOW_BYTES,
} from "./primitives.ts";

export type WorkStreamController = Readonly<{
  finishPending(
    pending: PendingWork,
    dispatch: WorkDispatch,
    streamError?: HypervisorError,
  ): void;
  handleControl(
    record: ConnectionRecord,
    frame: ControlFrame,
    disposition: "deliver" | "discard",
  ): Promise<boolean>;
  handleData(
    record: ConnectionRecord,
    frame: Readonly<{ streamId: string; payload: Uint8Array }>,
    disposition: "deliver" | "discard",
  ): Promise<void>;
  open(
    record: ConnectionRecord,
    operationId: string,
    payload: PendingOpenInput,
    signal: AbortSignal | undefined,
  ): WorkHandle;
}>;

/**
 * Owns one operation from WorkOpen through stream settlement.
 *
 * Transport ordering, durable acceptance, bidirectional credit, cancellation,
 * deadlines, and reservation release stay together so no extracted caller can
 * accidentally cross the no-replay boundary out of order.
 */
export function createWorkStreamController(
  options: Readonly<{
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    dispatcher: WorkDispatcher;
    acceptanceAdmission: AcceptanceAdmissionState;
    closeRecord: CloseRecord;
    drainRecord: DrainRecord;
  }>,
): WorkStreamController {
  const {
    config,
    clock,
    scheduler,
    sessions,
    dispatcher,
    acceptanceAdmission,
    closeRecord,
    drainRecord,
  } = options;

  const finishPending = (
    pending: PendingWork,
    dispatch: WorkDispatch,
    streamError?: HypervisorError,
  ): void => {
    pending.record.pending.delete(pending.streamId);
    if (pending.deadlineTimer !== undefined) {
      scheduler.cancel(pending.deadlineTimer);
      pending.deadlineTimer = undefined;
    }
    if (pending.cancellationTimer !== undefined) {
      scheduler.cancel(pending.cancellationTimer);
      pending.cancellationTimer = undefined;
    }
    pending.inputAbort.abort(streamError);
    void pending.inputReader?.cancel(streamError).catch(() => undefined);
    if (!pending.startedValue) {
      pending.started.reject(
        streamError ??
          createHypervisorError(
            "work_failed",
            "work stream ended before execution started",
            {
              identity: pending.fence.identity,
              operationId: pending.operationId,
            },
          ),
      );
    }
    if (!pending.metadataValue) {
      pending.metadata.reject(
        streamError ??
          createHypervisorError(
            "work_failed",
            "worker ended without response metadata",
            {
              identity: pending.fence.identity,
              operationId: pending.operationId,
            },
          ),
      );
    }
    if (!pending.outputClosed) {
      pending.outputClosed = true;
      try {
        if (streamError === undefined) pending.outputController?.close();
        else pending.outputController?.error(streamError);
      } catch {
        // Consumer cancellation may already have closed the controller.
      }
    }
    pending.completed.resolve(dispatch);
    if (dispatch.status === "reschedulable") {
      dispatcher.discard(dispatch.operationId);
    }
  };

  const workError = (
    pending: PendingWork,
    code: HypervisorErrorCode,
    message: string,
  ): HypervisorError =>
    createHypervisorError(code, message, {
      identity: pending.fence.identity,
      operationId: pending.operationId,
    });

  const abortPendingOutput = (
    pending: PendingWork,
    error: HypervisorError,
  ): void => {
    pending.outputCredit = 0;
    if (pending.outputClosed) return;
    pending.outputClosed = true;
    try {
      pending.outputController?.error(error);
    } catch {
      // ReadableStream.cancel closes the controller before invoking its source.
    }
  };

  const sendLocalEnd = async (pending: PendingWork): Promise<void> => {
    if (pending.localTerminal || pending.localAborted) return;
    pending.localTerminal = true;
    await pending.record.transport!.sendControl({
      protocol: WORKER_PROTOCOL,
      type: "work.end",
      streamId: pending.streamId,
    }, { signal: pending.record.abort.signal });
  };

  const sendLocalCancel = async (
    pending: PendingWork,
    reason: string,
  ): Promise<void> => {
    if (pending.localAborted) return;
    pending.localTerminal = true;
    pending.localAborted = true;
    await pending.record.transport!.sendControl({
      protocol: WORKER_PROTOCOL,
      type: "work.cancel",
      streamId: pending.streamId,
      reason: reason.slice(0, 512) || "cancelled",
    }, { signal: pending.record.abort.signal });
  };

  const armCancellationTimeout = (
    pending: PendingWork,
    closeReason: string,
  ): void => {
    if (pending.cancellationTimer !== undefined) return;
    pending.cancellationTimer = scheduler.schedule(() => {
      void closeRecord(
        pending.record,
        INTERNAL_CLOSE_CODE,
        closeReason,
        "work_stream_failed",
      );
    }, config.cancellationAckTimeoutMs);
  };

  const cancelPendingWork = async (
    pending: PendingWork,
    reason = "caller_cancelled",
  ): Promise<WorkDispatch> => {
    const cancellationError = workError(pending, "work_failed", reason);
    abortPendingOutput(pending, cancellationError);
    const current = dispatcher.get(pending.operationId);
    if (current === undefined) return await pending.completed.promise;
    if (
      current.status === "completed" ||
      current.status === "cancelled" ||
      current.status === "failed" ||
      current.status === "indeterminate" ||
      current.status === "reschedulable"
    ) {
      return await pending.completed.promise;
    }
    if (current.status !== "cancelling") {
      dispatcher.cancel(pending.operationId, {
        code: "caller_cancelled",
        message: reason,
      });
    }
    pending.inputAbort.abort(cancellationError);
    void pending.inputReader?.cancel(reason).catch(() => undefined);
    armCancellationTimeout(pending, "cancellation_timeout");
    try {
      await sendLocalCancel(pending, reason);
    } catch (error) {
      if (
        errorCode(error) === "post_terminal_frame" ||
        errorCode(error) === "unknown_stream"
      ) {
        return await pending.completed.promise;
      }
      await closeRecord(
        pending.record,
        INTERNAL_CLOSE_CODE,
        "cancellation_send_failed",
        "work_stream_failed",
      );
      return await pending.completed.promise;
    }
    return await pending.completed.promise;
  };

  const grantOutputCredit = async (
    pending: PendingWork,
  ): Promise<void> => {
    if (
      !pending.startedValue ||
      pending.peerTerminal ||
      pending.localAborted ||
      pending.outputClosed ||
      pending.outputGranting
    ) {
      return;
    }
    const desired = pending.outputController?.desiredSize ?? 0;
    const window = Math.min(
      OUTPUT_WINDOW_BYTES,
      config.maxReceiveCreditBytes,
    );
    const target = Math.min(window, Math.max(0, Math.floor(desired)));
    const bytes = target - pending.outputCredit;
    if (bytes < 1) return;
    pending.outputGranting = true;
    pending.outputCredit += bytes;
    try {
      await pending.record.transport!.sendControl({
        protocol: WORKER_PROTOCOL,
        type: "work.credit",
        streamId: pending.streamId,
        bytes,
      }, { signal: pending.record.abort.signal });
    } catch (error) {
      if (
        errorCode(error) === "post_terminal_frame" ||
        errorCode(error) === "unknown_stream"
      ) {
        pending.outputCredit = 0;
        return;
      }
      await closeRecord(
        pending.record,
        INTERNAL_CLOSE_CODE,
        "output_credit_failed",
        "work_stream_failed",
      );
    } finally {
      pending.outputGranting = false;
    }
  };

  const pumpInput = async (pending: PendingWork): Promise<void> => {
    if (
      !pending.startedValue ||
      pending.inputPumping ||
      pending.localTerminal
    ) {
      return;
    }
    pending.inputPumping = true;
    try {
      while (
        !pending.localTerminal &&
        !pending.inputAbort.signal.aborted
      ) {
        if (
          pending.inputBuffer === undefined ||
          pending.inputOffset >= pending.inputBuffer.byteLength
        ) {
          pending.inputBuffer = undefined;
          pending.inputOffset = 0;
          if (pending.body instanceof Uint8Array) {
            if (pending.body.byteLength > 0) {
              pending.inputBuffer = pending.body;
            }
            pending.body = undefined;
          } else if (pending.body instanceof ReadableStream) {
            pending.inputReader ??= pending.body.getReader();
            const next = await pending.inputReader.read();
            if (next.done) {
              pending.body = undefined;
              await sendLocalEnd(pending);
              return;
            }
            if (!(next.value instanceof Uint8Array)) {
              await cancelPendingWork(
                pending,
                "request body yielded a non-Uint8Array chunk",
              );
              return;
            }
            if (next.value.byteLength > config.maxDataPayloadBytes) {
              void cancelPendingWork(
                pending,
                `request body chunk exceeds ${config.maxDataPayloadBytes} bytes`,
              );
              return;
            }
            if (next.value.byteLength === 0) continue;
            pending.inputBuffer = next.value;
          } else {
            await sendLocalEnd(pending);
            return;
          }
          if (pending.inputBuffer === undefined) continue;
        }

        // One validated chunk of lookahead lets an exact-credit final chunk
        // discover EOF and promptly send the local work.end half-close.
        if (pending.inputCredit < 1) return;
        const remaining = pending.inputBuffer.byteLength -
          pending.inputOffset;
        const bytes = Math.min(
          remaining,
          pending.inputCredit,
          config.maxDataPayloadBytes,
        );
        const payload = pending.inputBuffer.subarray(
          pending.inputOffset,
          pending.inputOffset + bytes,
        );
        pending.inputOffset += bytes;
        pending.inputCredit -= bytes;
        await pending.record.transport!.sendData({
          type: "work.data",
          streamId: pending.streamId,
          sequence: pending.inputSequence++,
          payload,
        }, { signal: pending.inputAbort.signal });
      }
    } catch {
      if (!pending.inputAbort.signal.aborted) {
        void cancelPendingWork(pending, "request body streaming failed");
      }
    } finally {
      pending.inputPumping = false;
      if (
        !pending.localTerminal &&
        !pending.inputAbort.signal.aborted &&
        (pending.inputCredit > 0 || pending.inputBuffer === undefined)
      ) {
        queueMicrotask(() => void pumpInput(pending));
      }
    }
  };

  const commitAndStart = async (
    pending: PendingWork,
  ): Promise<void> => {
    let acceptanceCommitAdmitted = false;
    try {
      const workerId = pending.fence.identity.workerId;
      const workerPending = acceptanceAdmission.byWorker.get(workerId) ?? 0;
      if (
        acceptanceAdmission.pending >= config.maxPendingAcceptanceCommits ||
        workerPending >= config.maxPendingAcceptanceCommitsPerWorker
      ) {
        const rejected = workError(
          pending,
          "reschedulable",
          "acceptance persistence admission is temporarily exhausted",
        );
        pending.started.reject(rejected);
        abortPendingOutput(pending, rejected);
        armCancellationTimeout(
          pending,
          "acceptance_capacity_cancellation_timeout",
        );
        await sendLocalCancel(pending, "acceptance_commit_capacity");
        return;
      }

      acceptanceCommitAdmitted = true;
      acceptanceAdmission.pending++;
      acceptanceAdmission.byWorker.set(workerId, workerPending + 1);
      const committed = await dispatcher.commitAcceptance(
        pending.operationId,
        pending.fence,
        pending.streamId,
      );
      if (committed.status !== "committed") {
        if (committed.status === "indeterminate") {
          const ambiguous = workError(
            pending,
            "indeterminate",
            committed.terminal?.message ??
              "acceptance persistence outcome is unknown",
          );
          pending.started.reject(ambiguous);
          abortPendingOutput(pending, ambiguous);
          if (
            pending.peerTerminal ||
            pending.record.phase === "closed" ||
            pending.record.abort.signal.aborted ||
            !pending.record.pending.has(pending.streamId)
          ) {
            finishPending(pending, committed, ambiguous);
            return;
          }
          // Capacity remains reserved until cancellation acknowledgement or
          // connection loss resolves the ambiguous persistence boundary.
          armCancellationTimeout(
            pending,
            "indeterminate_cancellation_timeout",
          );
          await sendLocalCancel(
            pending,
            "acceptance_persistence_unknown",
          );
        } else if (
          committed.status === "failed" ||
          committed.status === "cancelled"
        ) {
          finishPending(
            pending,
            committed,
            workError(pending, "work_failed", "worker rejected work"),
          );
        }
        return;
      }
      if (
        pending.peerTerminal ||
        pending.localAborted ||
        !pending.record.pending.has(pending.streamId)
      ) {
        return;
      }
      await pending.record.transport!.sendControl({
        protocol: WORKER_PROTOCOL,
        type: "work.start",
        streamId: pending.streamId,
      }, { signal: pending.record.abort.signal });
      pending.startedValue = true;
      pending.started.resolve();
      void grantOutputCredit(pending);
      if (pending.body === undefined) {
        await sendLocalEnd(pending);
      } else {
        void pumpInput(pending);
      }
    } catch (error) {
      if (
        errorCode(error) === "post_terminal_frame" ||
        errorCode(error) === "unknown_stream"
      ) {
        return;
      }
      await closeRecord(
        pending.record,
        INTERNAL_CLOSE_CODE,
        "work_start_failed",
        "work_stream_failed",
      ).catch(() => undefined);
      const current = dispatcher.get(pending.operationId);
      if (
        pending.record.pending.has(pending.streamId) &&
        current !== undefined &&
        (current.status === "indeterminate" ||
          current.status === "cancelled" ||
          current.status === "failed" ||
          current.status === "reschedulable")
      ) {
        finishPending(
          pending,
          current,
          workError(
            pending,
            current.status === "indeterminate"
              ? "indeterminate"
              : current.status === "reschedulable"
              ? "reschedulable"
              : "work_failed",
            error instanceof Error ? error.message : "work start failed",
          ),
        );
      }
    } finally {
      if (acceptanceCommitAdmitted) {
        acceptanceAdmission.pending--;
        const workerId = pending.fence.identity.workerId;
        const workerPending =
          (acceptanceAdmission.byWorker.get(workerId) ?? 1) - 1;
        if (workerPending < 1) {
          acceptanceAdmission.byWorker.delete(workerId);
        } else {
          acceptanceAdmission.byWorker.set(workerId, workerPending);
        }
      }
    }
  };

  const handleControl = async (
    record: ConnectionRecord,
    frame: ControlFrame,
    disposition: "deliver" | "discard",
  ): Promise<boolean> => {
    if (
      frame.type !== "work.accepted" &&
      frame.type !== "work.metadata" &&
      frame.type !== "work.credit" &&
      frame.type !== "work.end" &&
      frame.type !== "work.cancel" &&
      frame.type !== "work.error"
    ) {
      return false;
    }
    const pending = record.pending.get(frame.streamId);
    if (pending === undefined) {
      if (
        disposition === "discard" &&
        (frame.type === "work.cancel" || frame.type === "work.error")
      ) {
        await record.transport!.sendControl({
          protocol: WORKER_PROTOCOL,
          type: "work.cancel",
          streamId: frame.streamId,
          reason: "late_abort_ack",
        }, { signal: record.abort.signal });
        return true;
      }
      throw createHypervisorError(
        "invalid_state",
        `work frame references unknown stream ${frame.streamId}`,
        { identity: record.hello?.identity },
      );
    }

    if (frame.type === "work.accepted") {
      const claimed = dispatcher.claim(
        pending.operationId,
        pending.fence,
        pending.streamId,
      );
      if (claimed.status === "claimed") {
        void commitAndStart(pending);
      }
      return true;
    }
    if (frame.type === "work.metadata") {
      if (disposition === "deliver") {
        pending.metadataValue = true;
        pending.metadata.resolve(frame.metadata);
      }
      return true;
    }
    if (frame.type === "work.credit") {
      if (disposition === "deliver" && !pending.localTerminal) {
        pending.inputCredit += frame.bytes;
        void pumpInput(pending);
      }
      return true;
    }
    if (frame.type === "work.end") {
      pending.peerTerminal = "end";
      pending.outputCredit = 0;
      pending.inputAbort.abort("worker_response_complete");
      void pending.inputReader?.cancel("worker_response_complete").catch(() =>
        undefined
      );
      if (pending.localAborted) {
        // A crossed normal End does not acknowledge a local Cancel/Error.
        return true;
      }
      if (!pending.localTerminal) {
        await sendLocalEnd(pending);
      }
      if (!pending.outputClosed) {
        pending.outputClosed = true;
        try {
          pending.outputController?.close();
        } catch {
          // Consumer cancellation may race the queued peer End.
        }
      }
      const completed = dispatcher.complete(
        pending.operationId,
        pending.fence,
        pending.streamId,
      );
      finishPending(pending, completed);
      return true;
    }

    pending.peerTerminal = frame.type === "work.cancel" ? "cancel" : "error";
    pending.outputCredit = 0;
    pending.inputAbort.abort("worker_aborted");
    void pending.inputReader?.cancel("worker_aborted").catch(() => undefined);
    abortPendingOutput(
      pending,
      workError(
        pending,
        "work_failed",
        frame.type === "work.cancel" ? frame.reason : frame.message,
      ),
    );
    if (!pending.localAborted) {
      armCancellationTimeout(pending, "peer_terminal_ack_timeout");
      await sendLocalCancel(pending, "peer_terminal_ack");
    }
    const current = dispatcher.get(pending.operationId);
    if (current === undefined) return true;
    const terminal = current.status === "cancelling"
      ? dispatcher.confirmCancellation(
        pending.operationId,
        pending.fence,
        pending.streamId,
        frame.type === "work.cancel"
          ? { code: "worker_cancelled", message: frame.reason }
          : { code: frame.code, message: frame.message },
      )
      : dispatcher.settlePeerTerminal(
        pending.operationId,
        pending.fence,
        pending.streamId,
        frame.type === "work.cancel"
          ? { type: "cancel", reason: frame.reason }
          : { type: "error", code: frame.code, message: frame.message },
      );
    if (terminal.status !== "committing") {
      finishPending(
        pending,
        terminal,
        workError(
          pending,
          terminal.status === "indeterminate"
            ? "indeterminate"
            : terminal.status === "reschedulable"
            ? "reschedulable"
            : "work_failed",
          terminal.terminal?.message ?? "worker terminated work",
        ),
      );
    }
    return true;
  };

  const handleData = async (
    record: ConnectionRecord,
    frame: Readonly<{
      streamId: string;
      payload: Uint8Array;
    }>,
    disposition: "deliver" | "discard",
  ): Promise<void> => {
    const pending = record.pending.get(frame.streamId);
    if (pending === undefined) {
      throw createHypervisorError(
        "invalid_state",
        `work.data references unknown stream ${frame.streamId}`,
        { identity: record.hello?.identity },
      );
    }
    pending.outputCredit = Math.max(
      0,
      pending.outputCredit - frame.payload.byteLength,
    );
    if (
      disposition === "deliver" &&
      !pending.localAborted &&
      !pending.outputClosed
    ) {
      try {
        pending.outputController?.enqueue(frame.payload);
      } catch {
        void cancelPendingWork(pending, "response_consumer_closed");
      }
    }
    await grantOutputCredit(pending);
  };

  const armWorkDeadline = (
    pending: PendingWork,
    deadlineAtMs: number,
  ): void => {
    const arm = (): void => {
      if (
        pending.record.phase === "closed" ||
        !pending.record.pending.has(pending.streamId)
      ) {
        return;
      }
      const remaining = deadlineAtMs - clock();
      if (remaining <= 0) {
        pending.deadlineTimer = undefined;
        void cancelPendingWork(pending, "deadline_exceeded");
        return;
      }
      pending.deadlineTimer = scheduler.schedule(
        arm,
        Math.min(MAX_TIMER_MS, remaining),
      );
    };
    arm();
  };

  const bindCallerCancellation = (
    handle: WorkHandle,
    signal: AbortSignal | undefined,
  ): void => {
    if (signal === undefined) return;
    let active = true;
    const abort = (): void => {
      if (!active) return;
      void handle.cancel(
        typeof signal.reason === "string" ? signal.reason : "caller_aborted",
      ).catch(() => undefined);
    };
    const dispose = (): void => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    handle.completed.then(dispose, dispose);
    if (signal.aborted) abort();
  };

  const open = (
    record: ConnectionRecord,
    operationId: string,
    payload: PendingOpenInput,
    signal: AbortSignal | undefined,
  ): WorkHandle => {
    assertCurrentFrame(record, sessions);
    if (record.fence === undefined || record.transport === undefined) {
      throw createHypervisorError(
        "worker_unavailable",
        "worker connection has no active transport",
      );
    }
    const session = sessions.assertCurrent(record.fence);
    if (!record.acceptingWork || session.phase !== "ready") {
      throw createHypervisorError(
        "worker_unavailable",
        "worker is no longer accepting new work",
        { identity: record.fence.identity, operationId },
      );
    }
    if (record.openedStreams >= config.maxLifetimeStreams) {
      record.acceptingWork = false;
      void drainRecord(record, "stream_lifetime", "rotate");
      throw createHypervisorError(
        "worker_unavailable",
        "worker connection reached its stream lifetime",
        { identity: record.fence.identity, operationId },
      );
    }
    record.openedStreams++;
    const reachedStreamLifetime =
      record.openedStreams >= config.maxLifetimeStreams;
    if (reachedStreamLifetime) record.acceptingWork = false;
    const started = createDeferred<void>();
    const metadata = createDeferred<JsonObject>();
    const completed = createDeferred<WorkDispatch>();
    // Assigned after ReadableStream callbacks capture the work lifecycle.
    // deno-lint-ignore prefer-const
    let pending!: PendingWork;
    let outputController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
      },
      pull() {
        void grantOutputCredit(pending);
      },
      cancel(reason) {
        return cancelPendingWork(
          pending,
          typeof reason === "string" ? reason : "output_cancelled",
        ).then(() => undefined);
      },
    }, {
      highWaterMark: Math.min(
        OUTPUT_WINDOW_BYTES,
        config.maxReceiveCreditBytes,
      ),
      size: (chunk) => chunk.byteLength,
    });
    pending = {
      record,
      operationId,
      streamId: payload.streamId,
      fence: record.fence,
      body: payload.body,
      inputOffset: 0,
      inputCredit: 0,
      inputSequence: 0,
      inputPumping: false,
      localTerminal: false,
      localAborted: false,
      startedValue: false,
      metadataValue: false,
      outputClosed: false,
      outputCredit: 0,
      outputGranting: false,
      inputAbort: new AbortController(),
      started,
      metadata,
      completed,
      outputController,
    };
    const handle: WorkHandle = Object.freeze({
      operationId,
      streamId: payload.streamId,
      metadata: metadata.promise,
      output,
      started: started.promise,
      completed: completed.promise,
      cancel: (reason) => cancelPendingWork(pending, reason),
    });
    pending.handle = handle;
    record.pending.set(payload.streamId, pending);
    const failAfterOpen = (
      wireReason: "work_open_failed" | "work_open_setup_failed",
    ): void => {
      void closeRecord(
        record,
        INTERNAL_CLOSE_CODE,
        wireReason,
        "work_stream_failed",
      ).catch(() => undefined);
    };
    let openDelivery: Promise<unknown>;
    try {
      openDelivery = record.transport.sendControl({
        protocol: WORKER_PROTOCOL,
        type: "work.open",
        streamId: payload.streamId,
        workload: payload.workload,
        metadata: payload.metadata,
        ...(payload.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: payload.deadlineAtMs }),
      }, { signal: record.abort.signal });
    } catch {
      failAfterOpen("work_open_failed");
      return handle;
    }
    // Once Open occupies the ordered send queue, all setup failures settle
    // through this handle; none may escape as a definitely-undelivered offer.
    void openDelivery.catch(() => failAfterOpen("work_open_failed"));
    try {
      if (payload.deadlineAtMs !== undefined) {
        armWorkDeadline(pending, payload.deadlineAtMs);
      }
      bindCallerCancellation(handle, signal);
      if (reachedStreamLifetime) {
        void drainRecord(record, "stream_lifetime", "rotate");
      }
    } catch {
      failAfterOpen("work_open_setup_failed");
    }
    return handle;
  };

  return Object.freeze({
    finishPending,
    handleControl,
    handleData,
    open,
  });
}
