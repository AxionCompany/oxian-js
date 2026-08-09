import {
  createProtocolErrorFrame,
  createProtocolOrderValidator,
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeControlFrame,
  isProtocolViolation,
  parseControlFrame,
  WORKER_PROTOCOL,
} from "../protocol/index.ts";
import { createBoundedAsyncQueue } from "./queue.ts";
import type { ConnectionClose, Frame } from "./frame.ts";
import type {
  ConnectWorkerWebSocketOptions,
  ProtocolTransport,
  ProtocolTransportMessage,
  ProtocolTransportOptions,
  TransportCloseOptions,
  TransportSendOptions,
} from "./types.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_INBOUND_MESSAGES = 64;
const DEFAULT_MAX_INBOUND_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_SEND_MESSAGES = 64;
const DEFAULT_MAX_PENDING_SEND_BYTES = 32 * 1024 * 1024;
const PROTOCOL_CLOSE_CODE = 4400;
const NORMAL_CLOSE_CODE = 1000;
const INTERNAL_ERROR_CLOSE_CODE = 4500;
const textEncoder = new TextEncoder();

function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function expectPositiveInteger(
  value: unknown,
  name: string,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 1
  ) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    try {
      socket.close(code, reason);
    } catch {
      // Reserved protocol codes are not exposed consistently by WebSocket
      // implementations. A code-less close still guarantees termination.
      try {
        socket.close();
      } catch {
        // The close/error event remains authoritative.
      }
    }
  }
}

function createConnectionDeadline(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("WebSocket connection timed out", "TimeoutError"),
    );
  }, timeoutMs);
  const abort = (): void => {
    controller.abort(signal?.reason ?? createAbortError("Connection aborted"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  });
}

function createAbortWaiter(signal: AbortSignal): Readonly<{
  promise: Promise<never>;
  dispose(): void;
}> {
  let abort: (() => void) | undefined;
  const promise = signal.aborted
    ? Promise.reject(signal.reason)
    : new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
  return Object.freeze({
    promise,
    dispose() {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    },
  });
}

function expectWebSocket(value: unknown): WebSocket {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as Partial<WebSocket>).addEventListener !== "function" ||
    typeof (value as Partial<WebSocket>).removeEventListener !== "function" ||
    typeof (value as Partial<WebSocket>).close !== "function" ||
    typeof (value as Partial<WebSocket>).send !== "function" ||
    typeof (value as Partial<WebSocket>).readyState !== "number"
  ) {
    throw new TypeError("worker WebSocket factory must return a WebSocket");
  }
  return value as WebSocket;
}

async function createWorkerSocket(
  options: ConnectWorkerWebSocketOptions,
  url: URL,
  deadline: ReturnType<typeof createConnectionDeadline>,
): Promise<WebSocket> {
  const factory = options.createWebSocket ??
    ((context) => new WebSocket(context.url, context.protocol));
  if (typeof factory !== "function") {
    throw new TypeError("createWebSocket must be a function");
  }
  const context = Object.freeze({
    url: new URL(url.href),
    protocol: WORKER_PROTOCOL,
    signal: deadline.signal,
  });
  const pending = Promise.resolve().then(() => factory(context));
  // A provider token call is allowed to be asynchronous. If it ignores the
  // deadline and resolves later, close the orphaned socket immediately.
  let deadlineWon = false;
  const abortWaiter = createAbortWaiter(deadline.signal);
  const aborted = abortWaiter.promise.catch((error) => {
    deadlineWon = true;
    throw error;
  });
  try {
    return expectWebSocket(await Promise.race([pending, aborted]));
  } finally {
    abortWaiter.dispose();
    if (deadlineWon) {
      void pending.then(
        (socket) => {
          try {
            closeSocket(
              expectWebSocket(socket),
              NORMAL_CLOSE_CODE,
              "connection_failed",
            );
          } catch {
            // The already reported deadline remains the caller-facing error.
          }
        },
        () => undefined,
      );
    }
  }
}

function validatePublicClose(
  code: number,
  reason: string,
): void {
  if (
    !Number.isSafeInteger(code) ||
    (code !== 1000 && (code < 3000 || code > 4999))
  ) {
    throw new TypeError(
      "WebSocket close code must be 1000 or an integer from 3000 through 4999",
    );
  }
  if (textEncoder.encode(reason).byteLength > 123) {
    throw new TypeError(
      "WebSocket close reason must not exceed 123 UTF-8 bytes",
    );
  }
}

/**
 * Opens an outbound worker connection with the exact v1 WebSocket subprotocol.
 *
 * Production endpoints must use `wss:`. Plain `ws:` is deliberately limited
 * to explicit loopback development/test connections.
 */
export async function connectWorkerWebSocket(
  options: ConnectWorkerWebSocketOptions,
): Promise<WebSocket> {
  const url = new URL(options.url);
  if (
    url.protocol !== "wss:" &&
    !(
      url.protocol === "ws:" &&
      options.allowInsecureLoopback === true &&
      isLoopbackHostname(url.hostname)
    )
  ) {
    throw new TypeError(
      "worker WebSocket URL must use wss: (ws: is permitted only for explicitly enabled loopback connections)",
    );
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "worker WebSocket URL must be credential-free and must not include a query or fragment",
    );
  }

  const timeoutMs = expectPositiveInteger(
    options.timeoutMs,
    "timeoutMs",
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  if (options.signal?.aborted) {
    throw options.signal.reason ?? createAbortError("Connection aborted");
  }

  const deadline = createConnectionDeadline(options.signal, timeoutMs);
  let socket: WebSocket | undefined;
  try {
    socket = await createWorkerSocket(options, url, deadline);
    try {
      socket.binaryType = "arraybuffer";
    } catch (cause) {
      throw new TypeError(
        "worker WebSocket factory returned an invalid socket",
        {
          cause,
        },
      );
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        socket!.removeEventListener("open", open);
        socket!.removeEventListener("error", error);
        socket!.removeEventListener("close", close);
        deadline.signal.removeEventListener("abort", abort);
      };

      const succeed = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const fail = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        closeSocket(socket!, NORMAL_CLOSE_CODE, "connection_failed");
        reject(reason);
      };

      const open = (): void => succeed();
      const error = (): void =>
        fail(new TypeError("WebSocket connection failed"));
      const close = (event: CloseEvent): void =>
        fail(
          new TypeError(
            `WebSocket closed during connection (${event.code}: ${event.reason})`,
          ),
        );
      const abort = (): void => fail(deadline.signal.reason);

      socket!.addEventListener("open", open, { once: true });
      socket!.addEventListener("error", error, { once: true });
      socket!.addEventListener("close", close, { once: true });
      deadline.signal.addEventListener("abort", abort, { once: true });

      if (socket!.readyState === WebSocket.OPEN) succeed();
      else if (socket!.readyState !== WebSocket.CONNECTING) {
        fail(new TypeError("worker WebSocket closed before connection"));
      } else if (deadline.signal.aborted) abort();
    });

    if (socket.protocol !== WORKER_PROTOCOL) {
      closeSocket(socket, PROTOCOL_CLOSE_CODE, "unsupported_protocol");
      throw new TypeError(
        `WebSocket server did not negotiate ${WORKER_PROTOCOL}`,
      );
    }
    return socket;
  } catch (error) {
    if (socket !== undefined) {
      closeSocket(socket, NORMAL_CLOSE_CODE, "connection_failed");
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

function encodedBytes(frame: Frame): number {
  return typeof frame === "string"
    ? textEncoder.encode(frame).byteLength
    : frame.byteLength;
}

/**
 * Applies the single v1 codec, order validator, and bounded protocol queues to
 * any physical FrameConnection.
 */
export function createProtocolTransport(
  options: ProtocolTransportOptions,
): ProtocolTransport {
  const connection = options.connection;
  const maxInboundMessages = expectPositiveInteger(
    options.maxInboundMessages,
    "maxInboundMessages",
    DEFAULT_MAX_INBOUND_MESSAGES,
  );
  const maxInboundBytes = expectPositiveInteger(
    options.maxInboundBytes,
    "maxInboundBytes",
    DEFAULT_MAX_INBOUND_BYTES,
  );
  const maxPendingSendMessages = expectPositiveInteger(
    options.maxPendingSendMessages,
    "maxPendingSendMessages",
    DEFAULT_MAX_PENDING_SEND_MESSAGES,
  );
  const maxPendingSendBytes = expectPositiveInteger(
    options.maxPendingSendBytes,
    "maxPendingSendBytes",
    DEFAULT_MAX_PENDING_SEND_BYTES,
  );
  const validator = createProtocolOrderValidator({
    ...options.protocol,
    role: options.role,
  });
  if (options.signal?.aborted) {
    throw options.signal.reason ?? createAbortError("Transport aborted");
  }
  if (connection.protocol !== WORKER_PROTOCOL) {
    connection.close("unsupported_protocol", PROTOCOL_CLOSE_CODE);
    throw new TypeError(
      `connection did not negotiate exact protocol ${WORKER_PROTOCOL}`,
    );
  }

  const queue = createBoundedAsyncQueue<ProtocolTransportMessage>({
    maxItems: maxInboundMessages,
    maxWeight: maxInboundBytes,
    weigh: (message) => message.wireBytes,
  });
  let messagesClaimed = false;
  let terminal = false;
  let sendTail = Promise.resolve();
  let pendingSendMessages = 0;
  let pendingSendBytes = 0;
  let resolveClosed:
    | ((close: ConnectionClose) => void)
    | undefined;
  const closed = new Promise<ConnectionClose>((resolve) => {
    resolveClosed = resolve;
  });

  const finish = (
    close: ConnectionClose,
    error?: unknown,
    discardInbound = false,
  ): void => {
    if (terminal) return;
    terminal = true;
    options.signal?.removeEventListener("abort", abortTransport);
    queue.close(error, { discard: discardInbound });
    resolveClosed?.(close);
    resolveClosed = undefined;
  };

  const failProtocol = (error: unknown): void => {
    if (terminal) return;
    const code = isProtocolViolation(error)
      ? error.code
      : "invalid_binary_frame";
    try {
      const frame = createProtocolErrorFrame({
        ...(validator.snapshot().connectionId === undefined
          ? {}
          : { connectionId: validator.snapshot().connectionId }),
        code,
        message: `Worker protocol violation: ${code}`,
      });
      void connection.send(encodeControlFrame(frame), {
        beforeSend() {
          validator.acceptControl("sent", frame);
        },
      }).catch(() => undefined)
        .finally(() => {
          connection.close(code, PROTOCOL_CLOSE_CODE);
        });
    } catch {
      connection.close(code, PROTOCOL_CLOSE_CODE);
    }
    finish(
      { code: PROTOCOL_CLOSE_CODE, reason: code, wasClean: false },
      error,
      true,
    );
  };

  const failTransport = (error: unknown): void => {
    if (terminal) return;
    connection.close("transport_failed", INTERNAL_ERROR_CLOSE_CODE);
    finish(
      {
        code: INTERNAL_ERROR_CLOSE_CODE,
        reason: "transport_failed",
        wasClean: false,
      },
      error,
      true,
    );
  };

  const processMessage = (data: Frame): void => {
    if (terminal) return;
    const wireBytes = encodedBytes(data);
    try {
      let message: ProtocolTransportMessage;
      if (typeof data === "string") {
        const acceptance = validator.acceptControl(
          "received",
          parseControlFrame(data),
        );
        message = { kind: "control", acceptance, wireBytes };
      } else {
        const acceptance = validator.acceptBinary(
          "received",
          decodeBinaryFrame(data),
        );
        message = { kind: "data", acceptance, wireBytes };
      }
      if (!queue.push(message)) {
        failProtocol(
          new TypeError("inbound protocol queue exceeded its bound"),
        );
      }
    } catch (error) {
      failProtocol(error);
    }
  };

  function abortTransport(): void {
    const error = options.signal?.reason ?? createAbortError(
      "Transport aborted",
    );
    connection.close("transport_aborted", NORMAL_CLOSE_CODE);
    finish(
      { code: NORMAL_CLOSE_CODE, reason: "transport_aborted", wasClean: true },
      error,
      true,
    );
  }

  const reader = connection.incoming.getReader();
  void (async () => {
    try {
      while (!terminal) {
        const next = await reader.read();
        if (next.done) break;
        processMessage(next.value);
      }
      if (!terminal) finish(await connection.closed);
    } catch (error) {
      if (!terminal) failTransport(error);
    } finally {
      reader.releaseLock();
    }
  })();
  options.signal?.addEventListener("abort", abortTransport, { once: true });

  const serializeSend = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const result = sendTail.then(operation, operation);
    sendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const reserveSend = (wireBytes: number): () => void => {
    if (
      pendingSendMessages >= maxPendingSendMessages ||
      wireBytes > maxPendingSendBytes - pendingSendBytes
    ) {
      throw new RangeError("pending protocol send queue exceeded its bound");
    }
    pendingSendMessages++;
    pendingSendBytes += wireBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingSendMessages--;
      pendingSendBytes -= wireBytes;
    };
  };

  const sendControl: ProtocolTransport["sendControl"] = (
    frame,
    sendOptions: TransportSendOptions = {},
  ) => {
    if (terminal) {
      return Promise.reject(new TypeError("protocol transport is closed"));
    }
    let encoded: string;
    let validatedFrame: typeof frame;
    let release: () => void;
    try {
      encoded = encodeControlFrame(frame);
      validatedFrame = parseControlFrame(encoded);
      release = reserveSend(textEncoder.encode(encoded).byteLength);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = serializeSend(async () => {
      let acceptance: ReturnType<typeof validator.acceptControl> | undefined;
      try {
        await connection.send(encoded, {
          signal: sendOptions.signal,
          beforeSend() {
            acceptance = validator.acceptControl("sent", validatedFrame);
          },
        });
      } catch (error) {
        if (!isProtocolViolation(error)) failTransport(error);
        throw error;
      }
      return acceptance!;
    });
    return operation.then(
      (acceptance) => {
        release();
        return acceptance;
      },
      (error) => {
        release();
        throw error;
      },
    );
  };

  const sendData: ProtocolTransport["sendData"] = (
    frame,
    sendOptions: TransportSendOptions = {},
  ) => {
    if (terminal) {
      return Promise.reject(new TypeError("protocol transport is closed"));
    }
    let encoded: Uint8Array;
    let validatedFrame: typeof frame;
    let release: () => void;
    try {
      encoded = encodeBinaryFrame(frame);
      validatedFrame = decodeBinaryFrame(encoded);
      release = reserveSend(encoded.byteLength);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = serializeSend(async () => {
      let acceptance: ReturnType<typeof validator.acceptBinary> | undefined;
      try {
        await connection.send(encoded, {
          signal: sendOptions.signal,
          beforeSend() {
            acceptance = validator.acceptBinary("sent", validatedFrame);
          },
        });
      } catch (error) {
        if (!isProtocolViolation(error)) failTransport(error);
        throw error;
      }
      return acceptance!;
    });
    return operation.then(
      (acceptance) => {
        release();
        return acceptance;
      },
      (error) => {
        release();
        throw error;
      },
    );
  };

  const messages = (): AsyncIterable<ProtocolTransportMessage> => {
    if (messagesClaimed) {
      throw new TypeError(
        "protocol transport messages may have only one consumer",
      );
    }
    messagesClaimed = true;
    return queue.iterable;
  };

  const close = async (
    closeOptions: TransportCloseOptions = {},
  ): Promise<void> => {
    if (terminal) return;
    const code = closeOptions.code ?? NORMAL_CLOSE_CODE;
    const reason = closeOptions.reason ?? "transport_closed";
    validatePublicClose(code, reason);
    const timeoutMs = expectPositiveInteger(
      closeOptions.timeoutMs,
      "timeoutMs",
      DEFAULT_CLOSE_TIMEOUT_MS,
    );
    connection.close(reason, code);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        finish({ code, reason, wasClean: false });
        resolve();
      }, timeoutMs);
      closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  return Object.freeze({
    sendControl,
    sendData,
    messages,
    snapshot: validator.snapshot,
    close,
    closed,
  });
}
