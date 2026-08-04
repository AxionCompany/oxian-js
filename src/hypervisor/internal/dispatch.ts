import type { WorkDispatcher } from "../../supervisor/index.ts";
import type { Hypervisor, HypervisorWorkHandle } from "../types.ts";
import type { ConnectionDirectory } from "./directory.ts";
import type { ConnectionRecord, PendingOpenInput } from "./model.ts";
import { createHypervisorError } from "./primitives.ts";

export function createDispatch(
  options: Readonly<{
    dispatcher: WorkDispatcher;
    directory: ConnectionDirectory;
    openPending(
      record: ConnectionRecord,
      operationId: string,
      payload: PendingOpenInput,
      signal: AbortSignal | undefined,
    ): HypervisorWorkHandle;
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
    const offered = options.dispatcher.offer({
      workload: input.workload,
      ...(input.target === undefined ? {} : { target: input.target }),
      metadata: input.metadata,
      ...(input.deadlineAtMs === undefined
        ? {}
        : { deadlineAtMs: input.deadlineAtMs }),
    });
    const assignment = offered.assignment!;
    try {
      const record = options.directory.get(assignment.fence.connectionId);
      if (record === undefined) {
        throw createHypervisorError(
          "worker_unavailable",
          "assigned worker connection is unavailable",
          {
            identity: assignment.fence.identity,
            operationId: offered.operationId,
          },
        );
      }
      return await Promise.resolve(
        options.openPending(
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
        ),
      );
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
