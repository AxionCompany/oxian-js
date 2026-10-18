import type { HypervisorConfig } from "../config.ts";
import { createHostCallChannel } from "../../work/host-call-channel.ts";
import type {
  WorkDispatcher,
  SessionRegistry,
} from "../../supervisor/index.ts";
import type { WorkerCallOptions, WorkerCallContext } from "../types.ts";
import type { ConnectionRecord } from "./model.ts";

export function createWorkerCallAdmission(
  options: WorkerCallOptions | undefined,
  sessions: SessionRegistry,
  dispatcher: WorkDispatcher,
  now: () => number,
  config: HypervisorConfig,
) {
  const positive = (
    value: number | undefined,
    fallback: number,
    maximum: number,
  ): number => {
    const number = value ?? fallback;
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
      throw new TypeError("invalid worker call limit");
    return number;
  };
  if (
    options !== undefined &&
    (typeof options.admit !== "function" ||
      (options.admitUnassigned !== undefined &&
        typeof options.admitUnassigned !== "function"))
  )
    throw new TypeError("workerCalls requires admission functions");
  const maximum = positive(options?.maxConcurrent, 32, 65_536);
  const capacity = positive(
    options?.maxPerConnection,
    Math.min(16, maximum),
    1024,
  );
  const timeoutMs = positive(options?.timeoutMs, 30_000, 0x7fff_ffff);
  const maxRequestBytes = positive(
    options?.maxRequestBytes,
    16 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER,
  );
  const maxResponseBytes = positive(
    options?.maxResponseBytes,
    16 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER,
  );
  let occupied = 0;
  const perConnection = new Map<string, number>();

  const attach = (record: ConnectionRecord, negotiated: number): void => {
    if (!options || !record.transport || !record.fence || !record.definition)
      return;
    record.hostCalls = createHostCallChannel({
      role: "hypervisor",
      transport: record.transport,
      signal: record.abort.signal,
      capacity: negotiated,
      timeoutMs,
      maxRequestBytes,
      maxResponseBytes,
      now,
      windowBytes: Math.min(256 * 1024, config.maxReceiveCreditBytes),
      maxDataPayloadBytes: config.maxDataPayloadBytes,
      cancellationAckTimeoutMs: config.cancellationAckTimeoutMs,
      accept(open, signal) {
        const fence = record.fence!;
        const pending =
          open.parentStreamId === undefined
            ? undefined
            : record.pending.get(open.parentStreamId);
        const parent =
          pending === undefined
            ? undefined
            : dispatcher.get(pending.operationId);
        const callback =
          open.parentStreamId === undefined
            ? options.admitUnassigned
            : options.admit;
        const current = (): boolean => {
          try {
            if (record.abort.signal.aborted || signal.aborted) return false;
            const session = sessions.assertCurrent(fence);
            if (session.phase !== "ready" && session.phase !== "draining")
              return false;
            if (open.parentStreamId === undefined)
              return session.phase === "ready" && record.acceptingWork;
            const latest =
              pending === undefined
                ? undefined
                : dispatcher.get(pending.operationId);
            return (
              pending !== undefined &&
              record.pending.get(open.parentStreamId) === pending &&
              pending.startedValue &&
              !pending.inputAbort.signal.aborted &&
              latest?.status === "committed" &&
              latest.assignment?.streamId === open.parentStreamId &&
              latest.assignment.fence.connectionId === fence.connectionId
            );
          } catch {
            return false;
          }
        };
        if (
          !callback ||
          !current() ||
          occupied >= maximum ||
          (perConnection.get(fence.connectionId) ?? 0) >= negotiated
        )
          return undefined;
        occupied++;
        perConnection.set(
          fence.connectionId,
          (perConnection.get(fence.connectionId) ?? 0) + 1,
        );
        const bindingSignal = AbortSignal.any([
          signal,
          record.abort.signal,
          ...(pending ? [pending.inputAbort.signal] : []),
        ]);
        const context: WorkerCallContext = Object.freeze({
          fence,
          definition: record.definition!,
          workload: open.workload,
          metadata: open.metadata,
          signal: bindingSignal,
          ...(parent && open.parentStreamId
            ? {
                parent: Object.freeze({
                  operationId: parent.operationId,
                  streamId: open.parentStreamId,
                  workload: parent.workload,
                  metadata: parent.metadata,
                }),
              }
            : {}),
        });
        // Parent completion/cancellation aborts the transport call as well as its handler.
        const cancelParent = (): void =>
          record.hostCalls?.cancelParent(open.parentStreamId!);
        pending?.inputAbort.signal.addEventListener("abort", cancelParent, {
          once: true,
        });
        let released = false;
        return {
          current,
          async admit() {
            const handler = await callback(context);
            return handler === undefined
              ? undefined
              : (execution) => handler({ ...execution, signal: bindingSignal });
          },
          release() {
            if (released) return;
            released = true;
            occupied--;
            const count = (perConnection.get(fence.connectionId) ?? 1) - 1;
            if (count === 0) perConnection.delete(fence.connectionId);
            else perConnection.set(fence.connectionId, count);
            pending?.inputAbort.signal.removeEventListener(
              "abort",
              cancelParent,
            );
          },
        };
      },
    });
  };
  return Object.freeze({ capacity: options ? capacity : undefined, attach });
}
