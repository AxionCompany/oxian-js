import { createInProcessWorker } from "./in-process.ts";
import { createWebSocketWorker } from "./websocket.ts";
import type {
  InProcessWorkerOptions,
  WebSocketWorkerOptions,
  Worker,
  WorkerOptions,
} from "./types.ts";

function isInProcess(
  options: WorkerOptions,
): options is InProcessWorkerOptions {
  return options.transport.type === "in-process";
}

/** Creates one Worker from a declarative transport descriptor. */
export function createWorker(options: WorkerOptions): Worker {
  if (options === null || typeof options !== "object") {
    throw new TypeError("worker options are required");
  }
  if (isInProcess(options)) {
    return createInProcessWorker(options);
  }
  if (options.transport?.type === "websocket") {
    return createWebSocketWorker(options as WebSocketWorkerOptions);
  }
  throw new TypeError('transport.type must be "in-process" or "websocket"');
}
