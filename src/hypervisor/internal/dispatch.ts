import {
  fenceForSession,
  type SessionRegistry,
  type WorkDispatch,
  type WorkDispatcher,
} from "../../supervisor/index.ts";
import type {
  HypervisorAssign,
  HypervisorWorkAssignedContext,
} from "../../lifecycle/index.ts";
import type { WorkHandle, WorkInput } from "../../work/types.ts";
import type { Hypervisor, HypervisorScheduler } from "../types.ts";
import type { HypervisorConfig } from "../config.ts";
import {
  copyJsonObject,
  expectFiniteTimestamp,
  expectWorkload,
} from "../../supervisor/internal.ts";
import { createWorkDispatchTarget } from "../../supervisor/state.ts";
import { createDispatchQueue, type QueueAttempt } from "./dispatch-queue.ts";
import { createHypervisorError } from "./primitives.ts";

export function createDispatch(
  options: Readonly<{
    config: HypervisorConfig;
    scheduler: HypervisorScheduler;
    dispatcher: WorkDispatcher;
    sessions: SessionRegistry;
    assign?: HypervisorAssign;
    onWorkAssigned?: (
      context: HypervisorWorkAssignedContext,
    ) => void | Promise<void>;
    clock: () => number;
    signal: AbortSignal;
    open(dispatch: WorkDispatch, input: WorkInput): WorkHandle;
  }>,
) {
  const queue = createDispatchQueue(options);
  const waiting = options.config.maxQueuedDispatches > 0;
  const dispatch: Hypervisor["dispatch"] = async (original) => {
    if (options.signal.aborted) {
      throw createHypervisorError(
        "shutting_down",
        "Hypervisor is shutting down",
      );
    }
    if (!waiting) original.signal?.throwIfAborted();
    const input: WorkInput = Object.freeze({
      ...original,
      workload: expectWorkload(original.workload, "workload"),
      target:
        original.target === undefined
          ? undefined
          : createWorkDispatchTarget(original.target),
      metadata: copyJsonObject(original.metadata),
      deadlineAtMs:
        original.deadlineAtMs === undefined
          ? undefined
          : expectFiniteTimestamp(original.deadlineAtMs, "deadlineAtMs"),
    });
    if (
      input.body !== undefined &&
      !(input.body instanceof Uint8Array) &&
      !(input.body instanceof ReadableStream)
    ) {
      throw new TypeError(
        "dispatch body must be a Uint8Array or ReadableStream<Uint8Array>",
      );
    }
    let offered: WorkDispatch;
    try {
      const operationId = crypto.randomUUID();
      const offer = (
        attempt?: QueueAttempt,
      ): WorkDispatch | undefined | Promise<WorkDispatch | undefined> => {
        let target = input.target;
        const reserve = (): WorkDispatch | undefined => {
          attempt?.assertActive();
          try {
            const offered = options.dispatcher.offer({
              operationId,
              workload: input.workload,
              ...(target === undefined ? {} : { target }),
              metadata: input.metadata,
              ...(input.deadlineAtMs === undefined
                ? {}
                : { deadlineAtMs: input.deadlineAtMs }),
            });
            // Leave the queue in the same turn that reserves capacity. An abort
            // between an async assign continuation and its promise settlement
            // must never strand an offered reservation.
            attempt?.offered(offered);
            return offered;
          } catch (error) {
            if (
              waiting &&
              error instanceof Error &&
              "code" in error &&
              error.code === "capacity_exhausted"
            )
              return undefined;
            throw error;
          }
        };
        if (options.assign !== undefined) {
          const available = options.sessions
            .list()
            .filter(
              (session) =>
                session.phase === "ready" &&
                session.workloads.includes(input.workload) &&
                session.reserved < session.capacity &&
                (input.target === undefined ||
                  input.target.workerId === session.identity.workerId),
            )
            .map(fenceForSession);
          const selection = options.assign(
            Object.freeze({
              stage: "assign" as const,
              stageId: `assign:${operationId}`,
              callbackAttempt: attempt?.callbackAttempt ?? 1,
              signal: attempt?.signal ?? input.signal ?? options.signal,
              operationId,
              workload: input.workload,
              metadata: input.metadata ?? {},
              ...(input.target === undefined ? {} : { target: input.target }),
              available: Object.freeze(available),
            }),
          );
          const selectedOffer = (
            selected: Awaited<ReturnType<HypervisorAssign>>,
          ): WorkDispatch | undefined => {
            attempt?.assertActive();
            if (selected !== undefined) {
              const candidate = available.find(
                (fence) =>
                  fence.connectionId === selected.connectionId &&
                  fence.sessionGeneration === selected.sessionGeneration &&
                  fence.identity.workerId === selected.identity.workerId &&
                  fence.identity.attemptId === selected.identity.attemptId &&
                  fence.identity.epoch === selected.identity.epoch,
              );
              if (candidate === undefined) {
                throw new TypeError(
                  "assign must return one of the available current session fences",
                );
              }
              if (waiting && !options.sessions.isCurrent(candidate)) {
                return undefined;
              }
              target = Object.freeze({ workerId: candidate.identity.workerId });
            }
            return reserve();
          };
          return Promise.resolve(selection).then(selectedOffer);
        }
        return reserve();
      };
      offered = waiting ? await queue.enqueue(input, offer) : (await offer())!;
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "capacity_exhausted"
      ) {
        throw createHypervisorError(
          "worker_unavailable",
          "no ready Worker has capacity for this workload",
          { cause },
        );
      }
      throw cause;
    }
    const assignment = offered.assignment!;
    try {
      await options.onWorkAssigned?.(
        Object.freeze({
          stage: "work_assigned" as const,
          stageId: `work_assigned:${offered.operationId}:${assignment.streamId}`,
          callbackAttempt: 1,
          signal: input.signal ?? options.signal,
          operationId: offered.operationId,
          workload: offered.workload,
          ...(offered.target === undefined ? {} : { target: offered.target }),
          metadata: offered.metadata,
          ...(offered.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: offered.deadlineAtMs }),
          deliveryCount: offered.deliveryCount,
          assignment,
          assignedAtMs: options.clock(),
        }),
      );
    } catch (cause) {
      options.dispatcher.withdrawOffer(
        offered.operationId,
        assignment.fence,
        assignment.streamId,
        {
          code: "work_assignment_rejected",
          message:
            cause instanceof Error
              ? cause.message
              : "work assignment callback failed",
        },
      );
      throw cause;
    }
    try {
      return await Promise.resolve(options.open(offered, input));
    } catch (cause) {
      const current = options.dispatcher.get(offered.operationId);
      if (current?.status === "offered") {
        options.dispatcher.withdrawOffer(
          offered.operationId,
          assignment.fence,
          assignment.streamId,
          {
            code: "connection_route_failed",
            message: "worker connection failed before WorkOpen delivery",
          },
        );
      } else if (current?.status === "reschedulable") {
        options.dispatcher.discard(current.operationId);
      }
      if (input.signal?.aborted) throw input.signal.reason;
      throw createHypervisorError(
        "worker_unavailable",
        "could not route work to the assigned worker connection",
        {
          identity: assignment.fence.identity,
          operationId: offered.operationId,
          cause,
        },
      );
    }
  };
  return Object.freeze({
    dispatch,
    snapshot: queue.snapshot,
    drainWorker: queue.drainWorker,
  });
}
