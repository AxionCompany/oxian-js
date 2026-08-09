import {
  type JsonObject,
  WORKER_PROTOCOL,
  type WorkerIdentity,
} from "../../protocol/index.ts";
import type { SessionRegistry } from "../../supervisor/index.ts";
import type { ConnectionClose } from "../../transport/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  HypervisorError,
  HypervisorErrorCode,
  HypervisorPeerClose,
  HypervisorScheduler,
} from "../types.ts";
import type { ConnectionRecord, Deferred } from "./model.ts";

export const POLICY_CLOSE_CODE = 4403;
export const INTERNAL_CLOSE_CODE = 4500;
export const NORMAL_CLOSE_CODE = 1000;
export const OUTPUT_WINDOW_BYTES = 64 * 1024;
export const MAX_TIMER_MS = 0x7fff_ffff;

export function cancelConnectionTimer(
  scheduler: HypervisorScheduler,
  record: ConnectionRecord,
  field:
    | "attachmentTimer"
    | "handshakeTimer"
    | "readyTimer"
    | "drainTimer"
    | "ageTimer",
): void {
  const handle = record[field];
  if (handle === undefined) return;
  scheduler.cancel(handle);
  record[field] = undefined;
}

export function createDefaultScheduler(): HypervisorScheduler {
  return Object.freeze({
    schedule(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // Internal lifecycle promises may settle before a caller observes them.
  promise.catch(() => undefined);
  return Object.freeze({ promise, resolve, reject });
}

export function createHypervisorError(
  code: HypervisorErrorCode,
  message: string,
  details: Readonly<{
    identity?: WorkerIdentity;
    operationId?: string;
    cause?: unknown;
  }> = {},
): HypervisorError {
  const error = new Error(message, {
    ...(details.cause === undefined ? {} : { cause: details.cause }),
  }) as HypervisorError;
  Object.defineProperties(error, {
    name: {
      configurable: true,
      value: "HypervisorError",
      writable: true,
    },
    code: {
      enumerable: true,
      value: code,
    },
    ...(details.identity === undefined ? {} : {
      identity: {
        enumerable: true,
        value: Object.freeze({ ...details.identity }),
      },
    }),
    ...(details.operationId === undefined ? {} : {
      operationId: {
        enumerable: true,
        value: details.operationId,
      },
    }),
  });
  return error;
}

export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

export function authenticationCode(error: unknown): string {
  const code = errorCode(error);
  if (
    code === "credential_invalid" ||
    code === "credential_expired" ||
    code === "stale_attempt"
  ) {
    return code;
  }
  return "authentication_failed";
}

export function ensureOpen(record: ConnectionRecord): void {
  if (
    record.phase === "closed" ||
    record.abort.signal.aborted ||
    record.connection === undefined
  ) {
    throw createHypervisorError(
      "connection_lost",
      "worker connection closed during an asynchronous handshake operation",
      { identity: record.hello?.identity },
    );
  }
}

export function assertCurrentFrame(
  record: ConnectionRecord,
  sessions: SessionRegistry,
): void {
  ensureOpen(record);
  if (record.fence === undefined || record.phase !== "ready") {
    throw createHypervisorError(
      "invalid_state",
      "worker sent a session frame before Ready completed",
      { identity: record.hello?.identity },
    );
  }
  sessions.assertCurrent(record.fence);
}

export function copyPeerClose(
  close: ConnectionClose,
): HypervisorPeerClose {
  return Object.freeze({
    code: close.code,
    reason: close.reason,
    wasClean: close.wasClean,
  });
}

export function copyBootstrap(input: JsonObject): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("createBootstrap must return a JSON object");
  }
  // The protocol encoder performs the authoritative depth, key, and size
  // validation before Welcome is sent.
  return input;
}

export function websocketRequestError(
  request: Request,
  config: HypervisorConfig,
  acceptingConnections: boolean,
  totalConnections: number,
  unauthenticatedConnections: number,
  handshakeOperations: number,
): Response | undefined {
  if (!acceptingConnections) {
    return new Response("Hypervisor is shutting down", { status: 503 });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET" },
    });
  }
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", {
      status: 426,
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": WORKER_PROTOCOL,
      },
    });
  }
  if (request.headers.get("sec-websocket-protocol") !== WORKER_PROTOCOL) {
    return new Response(`WebSocket subprotocol ${WORKER_PROTOCOL} required`, {
      status: 426,
      headers: { "sec-websocket-protocol": WORKER_PROTOCOL },
    });
  }
  if (totalConnections >= config.maxConnections) {
    return new Response("Worker connection limit reached", { status: 503 });
  }
  if (
    unauthenticatedConnections >= config.maxUnauthenticatedConnections ||
    handshakeOperations >= config.maxUnauthenticatedConnections
  ) {
    return new Response("Worker handshake limit reached", { status: 503 });
  }
  return undefined;
}

export function listenerUrl(hostname: string, port: number): URL {
  const formattedHostname = hostname.includes(":") ? `[${hostname}]` : hostname;
  return new URL(`http://${formattedHostname}:${port}/`);
}
