import type { JsonObject } from "../protocol/types.ts";
import type { WorkBody } from "./types.ts";

/** An invocation on the authenticated connection's host, never workload fallback. */
export type HostCallInput = Readonly<{
  workload: string;
  metadata?: JsonObject;
  body?: WorkBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

/** Completion is transport completion, not proof of a durable application commit. */
export type HostCallHandle = Readonly<{
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type HostCaller = (input: HostCallInput) => Promise<HostCallHandle>;

export type HostCallErrorCode =
  | "unsupported"
  | "unavailable"
  | "capacity"
  | "refused"
  | "cancelled"
  | "deadline_exceeded"
  | "connection_lost"
  | "handler_failed";

const hostCallErrorMarker = Symbol.for("oxian.worker.v1.host-call-error");

export type HostCallError = Error &
  Readonly<{
    code: HostCallErrorCode;
    execution: "not_started" | "indeterminate";
  }>;

/** Never automatically retry an indeterminate invocation; recover its application receipt. */
export function createHostCallError(
  code: HostCallErrorCode,
  execution: "not_started" | "indeterminate",
  message: string = code,
): HostCallError {
  const error = new Error(message) as HostCallError;
  Object.defineProperties(error, {
    name: { value: "HostCallError", configurable: true },
    code: { value: code, enumerable: true },
    execution: { value: execution, enumerable: true },
    [hostCallErrorMarker]: { value: true },
  });
  return error;
}

export function isHostCallError(value: unknown): value is HostCallError {
  return (
    value instanceof Error &&
    (value as unknown as Record<PropertyKey, unknown>)[hostCallErrorMarker] ===
      true
  );
}
