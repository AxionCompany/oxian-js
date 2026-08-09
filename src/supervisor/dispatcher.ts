import { createStreamId } from "../protocol/binary.ts";
import type { JsonObject } from "../protocol/types.ts";
import {
  copyJsonObject,
  expectFiniteTimestamp,
  expectIdentifier,
  expectWorkload,
  fail,
  freeze,
  sameIdentity,
} from "./internal.ts";
import { fenceForSession, type SessionRegistry } from "./sessions.ts";
import { createSessionFence, createWorkDispatchTarget } from "./state.ts";
import type {
  SessionFence,
  WorkAssignment,
  WorkDispatch,
  WorkDispatchTarget,
} from "./types.ts";

const STREAM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AcceptanceCommit = Readonly<{
  operationId: string;
  workload: string;
  target?: WorkDispatchTarget;
  /**
   * Immutable owner metadata supplied when the operation was dispatched.
   *
   * Durable adapters use this to associate Oxian's operation with their own
   * command or transaction before `work.start` authorizes execution.
   */
  metadata: JsonObject;
  deadlineAtMs?: number;
  deliveryCount: number;
  assignment: WorkAssignment;
  claimedAtMs: number;
}>;

export type WorkDispatcher = Readonly<{
  offer(
    input: Readonly<{
      operationId?: string;
      workload: string;
      target?: WorkDispatchTarget;
      metadata?: JsonObject;
      deadlineAtMs?: number;
    }>,
  ): WorkDispatch;
  retry(operationId: string): WorkDispatch;
  withdrawOffer(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  discard(operationId: string): WorkDispatch;
  claim(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): WorkDispatch;
  commitAcceptance(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): Promise<WorkDispatch>;
  complete(
    operationId: string,
    fence: SessionFence,
    streamId: string,
  ): WorkDispatch;
  fail(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    error: Readonly<{ code: string; message: string }>,
  ): WorkDispatch;
  cancel(
    operationId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  confirmCancellation(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch;
  settlePeerTerminal(
    operationId: string,
    fence: SessionFence,
    streamId: string,
    terminal:
      | Readonly<{ type: "cancel"; reason: string }>
      | Readonly<{ type: "error"; code: string; message: string }>,
  ): WorkDispatch;
  connectionLost(fence: SessionFence): readonly WorkDispatch[];
  get(operationId: string): WorkDispatch | undefined;
  list(): readonly WorkDispatch[];
}>;

function expectStreamId(streamId: string): string {
  if (typeof streamId !== "string" || !STREAM_ID_PATTERN.test(streamId)) {
    throw new TypeError("streamId must be a lowercase UUID");
  }
  return streamId;
}

function assignmentMatches(
  assignment: WorkAssignment | undefined,
  fence: SessionFence,
  streamId: string,
): assignment is WorkAssignment {
  return assignment !== undefined &&
    assignment.streamId === streamId &&
    assignment.fence.connectionId === fence.connectionId &&
    assignment.fence.sessionGeneration === fence.sessionGeneration &&
    sameIdentity(assignment.fence.identity, fence.identity);
}

function withDispatch(
  dispatch: WorkDispatch,
  changes: Partial<WorkDispatch>,
): WorkDispatch {
  return freeze({ ...dispatch, ...changes });
}

/**
 * Creates a transport-independent work admission ledger.
 *
 * `claim` corresponds to a worker's `work.accepted`: the worker has reserved the
 * stream but is not authorized to execute it. `commitAcceptance` first awaits
 * the owner's durable acceptance hook and only then crosses the no-replay
 * boundary. The gateway sends `work.start` only after that method returns a
 * committed dispatch. Rejection is conservatively ambiguous: it becomes
 * indeterminate and the gateway cancels that pre-start stream without
 * disturbing unrelated multiplexed work.
 *
 * Once work.open is sent, cancellation keeps capacity reserved until the worker
 * closes its stream or the connection is lost. This prevents a still-open
 * protocol stream from oversubscribing the worker.
 */
export function createWorkDispatcher(
  options: Readonly<{
    sessions: SessionRegistry;
    commitAcceptedWork(
      commit: AcceptanceCommit,
    ): Promise<void>;
    clock?: () => number;
    createWorkStreamId?: () => string;
  }>,
): WorkDispatcher {
  const clock = options.clock ?? Date.now;
  const createWorkStreamId = options.createWorkStreamId ?? createStreamId;
  const dispatches = new Map<string, WorkDispatch>();
  const commitTasks = new Map<string, Promise<WorkDispatch>>();
  const lostWhileCommitting = new Set<string>();
  const heldReservations = new Set<string>();

  const now = (): number => expectFiniteTimestamp(clock(), "clock()");

  const requireDispatch = (operationIdInput: string): WorkDispatch => {
    const operationId = expectIdentifier(operationIdInput, "operationId");
    const dispatch = dispatches.get(operationId);
    if (dispatch === undefined) {
      return fail("not_found", `operation ${operationId} does not exist`);
    }
    return dispatch;
  };

  const store = (dispatch: WorkDispatch): WorkDispatch => {
    dispatches.set(dispatch.operationId, dispatch);
    return dispatch;
  };

  const isTerminalStatus = (dispatch: WorkDispatch): boolean =>
    dispatch.status === "completed" ||
    dispatch.status === "cancelled" ||
    dispatch.status === "failed" ||
    dispatch.status === "indeterminate";

  const finish = (dispatch: WorkDispatch): WorkDispatch => {
    if (
      commitTasks.has(dispatch.operationId) ||
      heldReservations.has(dispatch.operationId)
    ) {
      dispatches.set(dispatch.operationId, dispatch);
    } else {
      dispatches.delete(dispatch.operationId);
    }
    return dispatch;
  };

  const assign = (dispatch: WorkDispatch): WorkDispatch => {
    const session = options.sessions.reserve({
      workload: dispatch.workload,
      ...(dispatch.target === undefined ? {} : { target: dispatch.target }),
    });
    const assignment = freeze({
      fence: fenceForSession(session),
      streamId: expectStreamId(createWorkStreamId()),
    });
    heldReservations.add(dispatch.operationId);
    return store(withDispatch(dispatch, {
      status: "offered",
      deliveryCount: dispatch.deliveryCount + 1,
      assignment,
      updatedAtMs: now(),
      claimedAtMs: undefined,
      committedAtMs: undefined,
      cancellation: undefined,
      terminal: undefined,
    }));
  };

  const releaseReservation = (
    operationId: string,
    fence: SessionFence,
  ): void => {
    if (!heldReservations.delete(operationId)) return;
    options.sessions.releaseIfCurrent(fence);
  };

  const offer = (
    input: Parameters<WorkDispatcher["offer"]>[0],
  ): WorkDispatch => {
    const operationId = expectIdentifier(
      input.operationId ?? crypto.randomUUID(),
      "operationId",
    );
    if (dispatches.has(operationId)) {
      return fail(
        "already_exists",
        `operation ${operationId} already exists`,
      );
    }
    const openedAtMs = now();
    const deadlineAtMs = input.deadlineAtMs === undefined
      ? undefined
      : expectFiniteTimestamp(input.deadlineAtMs, "deadlineAtMs");
    if (deadlineAtMs !== undefined && deadlineAtMs <= openedAtMs) {
      return fail("invalid_state", "work deadline has already elapsed");
    }
    const initial = freeze({
      operationId,
      workload: expectWorkload(input.workload, "workload"),
      ...(input.target === undefined
        ? {}
        : { target: createWorkDispatchTarget(input.target) }),
      metadata: copyJsonObject(input.metadata),
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      status: "reschedulable" as const,
      deliveryCount: 0,
      openedAtMs,
      updatedAtMs: openedAtMs,
    });
    dispatches.set(operationId, initial);
    try {
      return assign(initial);
    } catch (error) {
      dispatches.delete(operationId);
      throw error;
    }
  };

  const retry = (operationId: string): WorkDispatch => {
    const dispatch = requireDispatch(operationId);
    if (commitTasks.has(dispatch.operationId)) {
      return fail(
        "invalid_state",
        `operation ${dispatch.operationId} has an acceptance commit in flight`,
      );
    }
    if (dispatch.status !== "reschedulable") {
      return fail(
        "invalid_state",
        `operation ${dispatch.operationId} is ${dispatch.status}, not reschedulable`,
      );
    }
    return assign(dispatch);
  };

  /**
   * Rolls back an offer that its owner can prove was never delivered.
   *
   * This is deliberately narrower than cancellation: after WorkOpen may have
   * crossed the delivery boundary, capacity remains reserved until the worker
   * closes the stream or the connection is lost.
   */
  const withdrawOffer: WorkDispatcher["withdrawOffer"] = (
    operationId,
    fence,
    streamId,
    terminal,
  ) => {
    const dispatch = requireDispatch(operationId);
    const assignment = assertHeldAssignment(dispatch, fence, streamId);
    if (
      commitTasks.has(dispatch.operationId) || dispatch.status !== "offered"
    ) {
      return fail(
        "invalid_state",
        `cannot withdraw an operation in state ${dispatch.status}`,
      );
    }
    releaseReservation(operationId, assignment.fence);
    const reason = terminal === undefined ? undefined : freeze({ ...terminal });
    return finish(withDispatch(dispatch, {
      status: "cancelled",
      assignment: undefined,
      updatedAtMs: now(),
      ...(reason === undefined
        ? {}
        : { cancellation: reason, terminal: reason }),
    }));
  };

  /**
   * Evicts a final rescheduling decision after the caller has externalized it.
   *
   * Retry remains available to orchestration layers that deliberately retain
   * the in-memory entry. The Hypervisor uses discard because the public API exposes the
   * final reschedulable result rather than an implicit retry loop.
   */
  const discard: WorkDispatcher["discard"] = (operationId) => {
    const dispatch = requireDispatch(operationId);
    if (
      dispatch.status !== "reschedulable" ||
      dispatch.assignment !== undefined ||
      heldReservations.has(dispatch.operationId) ||
      commitTasks.has(dispatch.operationId)
    ) {
      return fail(
        "invalid_state",
        `cannot discard an operation in state ${dispatch.status}`,
      );
    }
    dispatches.delete(dispatch.operationId);
    return dispatch;
  };

  const assertHeldAssignment = (
    dispatch: WorkDispatch,
    fenceInput: SessionFence,
    streamIdInput: string,
  ): Readonly<{ fence: SessionFence; streamId: string }> => {
    const fence = createSessionFence(fenceInput);
    const streamId = expectStreamId(streamIdInput);
    if (!assignmentMatches(dispatch.assignment, fence, streamId)) {
      return fail(
        "stale_session",
        `operation ${dispatch.operationId} is not assigned to this session and stream`,
      );
    }
    return { fence, streamId };
  };

  const assertAssignment = (
    dispatch: WorkDispatch,
    fenceInput: SessionFence,
    streamIdInput: string,
  ): Readonly<{ fence: SessionFence; streamId: string }> => {
    const fence = createSessionFence(fenceInput);
    options.sessions.assertCurrent(fence);
    return assertHeldAssignment(
      dispatch,
      fence,
      streamIdInput,
    );
  };

  const claim = (
    operationId: string,
    fenceInput: SessionFence,
    streamIdInput: string,
  ): WorkDispatch => {
    const dispatch = requireDispatch(operationId);
    assertAssignment(dispatch, fenceInput, streamIdInput);
    if (
      dispatch.status === "cancelling" &&
      dispatch.claimedAtMs === undefined
    ) {
      return store(withDispatch(dispatch, {
        claimedAtMs: now(),
        updatedAtMs: now(),
      }));
    }
    if (dispatch.status !== "offered") {
      return fail(
        "invalid_state",
        `cannot claim an operation in state ${dispatch.status}`,
      );
    }
    return store(withDispatch(dispatch, {
      status: "claimed",
      claimedAtMs: now(),
      updatedAtMs: now(),
    }));
  };

  const commitAcceptance = (
    operationId: string,
    fenceInput: SessionFence,
    streamIdInput: string,
  ): Promise<WorkDispatch> => {
    const dispatch = requireDispatch(operationId);
    const { fence, streamId } = assertAssignment(
      dispatch,
      fenceInput,
      streamIdInput,
    );
    const existingTask = commitTasks.get(operationId);
    if (existingTask !== undefined) return existingTask;
    if (dispatch.status !== "claimed" || dispatch.claimedAtMs === undefined) {
      return fail(
        "invalid_state",
        `cannot commit acceptance from state ${dispatch.status}`,
      );
    }

    const committing = store(withDispatch(dispatch, {
      status: "committing",
      updatedAtMs: now(),
    }));
    const commit = freeze({
      operationId: committing.operationId,
      workload: committing.workload,
      ...(committing.target === undefined ? {} : { target: committing.target }),
      metadata: committing.metadata,
      ...(committing.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: committing.deadlineAtMs }),
      deliveryCount: committing.deliveryCount,
      assignment: committing.assignment!,
      claimedAtMs: committing.claimedAtMs!,
    });

    const task = Promise.resolve().then(async (): Promise<WorkDispatch> => {
      try {
        try {
          await options.commitAcceptedWork(commit);
        } catch {
          const current = requireDispatch(operationId);
          if (
            current.status === "cancelled" ||
            current.status === "failed"
          ) {
            return current;
          }
          return store(withDispatch(current, {
            status: "indeterminate",
            updatedAtMs: now(),
            terminal: freeze({
              code: "acceptance_persistence_unknown",
              message:
                "acceptance persistence did not confirm whether the no-replay boundary committed",
            }),
          }));
        }

        const current = requireDispatch(operationId);
        if (
          current.status === "cancelled" ||
          current.status === "failed"
        ) {
          return current;
        }
        const connectionLost = lostWhileCommitting.has(operationId) ||
          !options.sessions.isCurrent(fence);
        if (connectionLost) {
          return finish(withDispatch(current, {
            status: "indeterminate",
            assignment: undefined,
            updatedAtMs: now(),
            terminal: freeze({
              code: "connection_lost_before_start",
              message:
                "acceptance was persisted but the worker connection was lost before work.start delivery",
            }),
          }));
        }
        if (current.status === "cancelling") {
          return store(withDispatch(current, {
            committedAtMs: now(),
            updatedAtMs: now(),
          }));
        }
        if (
          current.status === "committing" &&
          current.terminal?.code === "worker_rejected_before_start"
        ) {
          return finish(withDispatch(current, {
            status: "indeterminate",
            updatedAtMs: now(),
            terminal: freeze({
              code: "accepted_worker_rejection",
              message:
                "the worker rejected the stream while acceptance persistence was in flight",
            }),
          }));
        }
        if (
          current.status !== "committing" ||
          !assignmentMatches(current.assignment, fence, streamId)
        ) {
          return fail(
            "invalid_state",
            "operation changed while acceptance was being committed",
          );
        }
        return store(withDispatch(current, {
          status: "committed",
          committedAtMs: now(),
          updatedAtMs: now(),
        }));
      } finally {
        commitTasks.delete(operationId);
        lostWhileCommitting.delete(operationId);
        const remaining = dispatches.get(operationId);
        if (
          remaining !== undefined &&
          isTerminalStatus(remaining) &&
          !heldReservations.has(operationId)
        ) {
          dispatches.delete(operationId);
        }
      }
    });
    commitTasks.set(operationId, task);
    return task;
  };

  const settle = (
    operationId: string,
    fence: SessionFence,
    streamId: string,
    status: "completed" | "failed",
    terminal?: Readonly<{ code?: string; message?: string }>,
  ): WorkDispatch => {
    const dispatch = requireDispatch(operationId);
    assertAssignment(dispatch, fence, streamId);
    if (
      dispatch.status !== "committed" &&
      dispatch.status !== "cancelling"
    ) {
      return fail(
        "invalid_state",
        `cannot settle an operation in state ${dispatch.status}`,
      );
    }
    releaseReservation(operationId, fence);
    return finish(withDispatch(dispatch, {
      status,
      updatedAtMs: now(),
      ...(terminal === undefined ? {} : { terminal: freeze({ ...terminal }) }),
    }));
  };

  const complete: WorkDispatcher["complete"] = (
    operationId,
    fence,
    streamId,
  ) => settle(operationId, fence, streamId, "completed");

  const failWork: WorkDispatcher["fail"] = (
    operationId,
    fence,
    streamId,
    error,
  ) => {
    return settle(operationId, fence, streamId, "failed", {
      code: expectIdentifier(error.code, "error.code"),
      message: error.message,
    });
  };

  const cancel: WorkDispatcher["cancel"] = (
    operationId,
    terminal,
  ) => {
    const dispatch = requireDispatch(operationId);
    if (dispatch.status === "cancelling") return dispatch;
    if (
      dispatch.status === "completed" ||
      dispatch.status === "cancelled" ||
      dispatch.status === "failed" ||
      dispatch.status === "indeterminate"
    ) {
      return fail(
        "invalid_state",
        `cannot cancel an operation in state ${dispatch.status}`,
      );
    }
    const cancellation = terminal === undefined
      ? undefined
      : freeze({ ...terminal });
    if (dispatch.assignment !== undefined) {
      return store(withDispatch(dispatch, {
        status: "cancelling",
        updatedAtMs: now(),
        ...(cancellation === undefined ? {} : { cancellation }),
      }));
    }
    return finish(withDispatch(dispatch, {
      status: "cancelled",
      updatedAtMs: now(),
      ...(cancellation === undefined
        ? {}
        : { cancellation, terminal: cancellation }),
    }));
  };

  const confirmCancellation: WorkDispatcher["confirmCancellation"] = (
    operationId,
    fence,
    streamId,
    terminal,
  ) => {
    const dispatch = requireDispatch(operationId);
    assertAssignment(dispatch, fence, streamId);
    if (dispatch.status !== "cancelling") {
      return fail(
        "invalid_state",
        `cannot confirm cancellation from state ${dispatch.status}`,
      );
    }
    releaseReservation(operationId, fence);
    const confirmation = terminal === undefined
      ? dispatch.cancellation
      : freeze({ ...terminal });
    return finish(withDispatch(dispatch, {
      status: "cancelled",
      updatedAtMs: now(),
      ...(confirmation === undefined ? {} : { terminal: confirmation }),
    }));
  };

  const settlePeerTerminal: WorkDispatcher["settlePeerTerminal"] = (
    operationId,
    fence,
    streamId,
    terminal,
  ) => {
    const dispatch = requireDispatch(operationId);
    assertAssignment(dispatch, fence, streamId);
    if (
      dispatch.status === "completed" ||
      dispatch.status === "cancelled" ||
      dispatch.status === "failed" ||
      dispatch.status === "reschedulable"
    ) {
      return fail(
        "invalid_state",
        `cannot settle a peer terminal from state ${dispatch.status}`,
      );
    }
    if (dispatch.status === "offered" || dispatch.status === "claimed") {
      releaseReservation(operationId, fence);
      return store(withDispatch(dispatch, {
        status: "reschedulable",
        assignment: undefined,
        updatedAtMs: now(),
      }));
    }
    if (dispatch.status === "committing") {
      releaseReservation(operationId, fence);
      return store(withDispatch(dispatch, {
        updatedAtMs: now(),
        terminal: freeze({
          code: "worker_rejected_before_start",
          message: terminal.type === "cancel"
            ? terminal.reason
            : terminal.message,
        }),
      }));
    }
    releaseReservation(operationId, fence);
    if (dispatch.status === "indeterminate") {
      return finish(dispatch);
    }
    if (terminal.type === "cancel") {
      const result = freeze({
        code: terminal.reason === "deadline_exceeded"
          ? "deadline_exceeded"
          : "worker_cancelled",
        message: terminal.reason,
      });
      return finish(withDispatch(dispatch, {
        status: "cancelled",
        cancellation: result,
        terminal: result,
        updatedAtMs: now(),
      }));
    }
    return finish(withDispatch(dispatch, {
      status: "failed",
      terminal: freeze({
        code: expectIdentifier(terminal.code, "terminal.code"),
        message: terminal.message,
      }),
      updatedAtMs: now(),
    }));
  };

  const connectionLost = (
    fenceInput: SessionFence,
  ): readonly WorkDispatch[] => {
    const fence = createSessionFence(fenceInput);
    const changed: WorkDispatch[] = [];
    for (const dispatch of dispatches.values()) {
      if (
        dispatch.assignment === undefined ||
        dispatch.assignment.fence.connectionId !== fence.connectionId ||
        dispatch.assignment.fence.sessionGeneration !==
          fence.sessionGeneration ||
        !sameIdentity(dispatch.assignment.fence.identity, fence.identity)
      ) {
        continue;
      }

      if (commitTasks.has(dispatch.operationId)) {
        lostWhileCommitting.add(dispatch.operationId);
        releaseReservation(dispatch.operationId, fence);
        changed.push(dispatch);
        continue;
      }

      if (
        dispatch.status !== "offered" &&
        dispatch.status !== "claimed" &&
        dispatch.status !== "committed" &&
        dispatch.status !== "cancelling" &&
        dispatch.status !== "indeterminate"
      ) {
        continue;
      }

      releaseReservation(dispatch.operationId, fence);
      const cancelledBeforeCommit = dispatch.status === "cancelling" &&
        dispatch.committedAtMs === undefined;
      const indeterminate = dispatch.status === "committed" ||
        (dispatch.status === "cancelling" && !cancelledBeforeCommit) ||
        dispatch.status === "indeterminate";
      const nextDispatch = withDispatch(dispatch, {
        status: indeterminate
          ? "indeterminate"
          : cancelledBeforeCommit
          ? "cancelled"
          : "reschedulable",
        assignment: undefined,
        updatedAtMs: now(),
        ...(indeterminate
          ? {
            terminal: freeze({
              code: dispatch.status === "cancelling"
                ? "connection_lost_during_cancellation"
                : dispatch.status === "indeterminate"
                ? dispatch.terminal?.code ??
                  "acceptance_persistence_unknown"
                : "connection_lost_after_commit",
              message: dispatch.status === "cancelling"
                ? "worker connection was lost before cancellation acknowledgement"
                : dispatch.status === "indeterminate"
                ? dispatch.terminal?.message ??
                  "acceptance persistence outcome is unknown"
                : "worker connection was lost after the no-replay boundary",
            }),
          }
          : cancelledBeforeCommit && dispatch.cancellation !== undefined
          ? { terminal: dispatch.cancellation }
          : {}),
      });
      const next = isTerminalStatus(nextDispatch)
        ? finish(nextDispatch)
        : store(nextDispatch);
      changed.push(next);
    }
    return Object.freeze(changed);
  };

  const get = (operationId: string): WorkDispatch | undefined => {
    return dispatches.get(expectIdentifier(operationId, "operationId"));
  };

  const list = (): readonly WorkDispatch[] => {
    return Object.freeze(Array.from(dispatches.values()));
  };

  return Object.freeze({
    offer,
    retry,
    withdrawOffer,
    discard,
    claim,
    commitAcceptance,
    complete,
    fail: failWork,
    cancel,
    confirmCancellation,
    settlePeerTerminal,
    connectionLost,
    get,
    list,
  });
}
