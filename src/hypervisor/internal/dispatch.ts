import type { WorkDispatch, WorkDispatcher } from "../../supervisor/index.ts";
import type { WorkHandle, WorkInput } from "../../work/types.ts";
import type { Hypervisor } from "../types.ts";
import { createHypervisorError } from "./primitives.ts";

export function createDispatch(
  options: Readonly<{
    dispatcher: WorkDispatcher;
    open(dispatch: WorkDispatch, input: WorkInput): WorkHandle;
  }>,
): Hypervisor["dispatch"] {
  return async (input) => {
    input.signal?.throwIfAborted();
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
      offered = options.dispatcher.offer({
        workload: input.workload,
        ...(input.target === undefined ? {} : { target: input.target }),
        metadata: input.metadata,
        ...(input.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: input.deadlineAtMs }),
      });
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
}
