import type { JsonObject } from "../protocol/types.ts";
import type { WorkDispatch, WorkDispatchTarget } from "../supervisor/types.ts";

/** Bytes accepted by every Oxian workload transport. */
export type WorkBody = Uint8Array | ReadableStream<Uint8Array>;

/** Transport-neutral work submitted to a Hypervisor. */
export type WorkInput = Readonly<{
  workload: string;
  target?: WorkDispatchTarget;
  metadata?: JsonObject;
  body?: WorkBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

/** One accepted or pending operation, independent of worker placement. */
export type WorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;

/** Minimal dispatch capability consumed by workload-owning libraries. */
export type Dispatcher = Readonly<{
  dispatch(input: WorkInput): Promise<WorkHandle>;
}>;
