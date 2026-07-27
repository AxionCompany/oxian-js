import type { JsonObject, WorkStreamTerminal } from "../../protocol/index.ts";
import type { WorkerBody, WorkerWorkResult } from "../types.ts";

export function terminalIsAbort(
  terminal: WorkStreamTerminal | undefined,
): boolean {
  return terminal === "cancel" || terminal === "error";
}

export function normalizeHandlerResult(
  result: WorkerWorkResult,
): Readonly<{ metadata?: JsonObject; body?: WorkerBody }> {
  if (result === undefined || result === null) return {};
  if (result instanceof Uint8Array || result instanceof ReadableStream) {
    return { body: result };
  }
  if (typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(
      "workload handler must return a Uint8Array, ReadableStream, result object, or void",
    );
  }
  const record = result as {
    metadata?: JsonObject;
    body?: WorkerBody | null;
  };
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) =>
      typeof key !== "string" || (key !== "metadata" && key !== "body")
    )
  ) {
    throw new TypeError("workload result contains an unsupported field");
  }
  if (
    record.body !== undefined &&
    record.body !== null &&
    !(record.body instanceof Uint8Array) &&
    !(record.body instanceof ReadableStream)
  ) {
    throw new TypeError(
      "workload result body must be a Uint8Array or ReadableStream",
    );
  }
  return {
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(record.body === undefined || record.body === null
      ? {}
      : { body: record.body }),
  };
}

export function bodyAsStream(
  body: WorkerBody,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (body.byteLength > 0) controller.enqueue(body);
      controller.close();
    },
  });
}
