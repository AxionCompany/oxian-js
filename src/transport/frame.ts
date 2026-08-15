import type { SocketClose, SocketConnection, SocketMessage } from "./types.ts";

const DEFAULT_MAX_INBOUND_FRAMES = 64;
const DEFAULT_MAX_INBOUND_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PENDING_SEND_FRAMES = 64;
const DEFAULT_MAX_PENDING_SEND_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 2 * 1024 * 1024;
const DEFAULT_BUFFERED_AMOUNT_LOW_WATER_BYTES = 512 * 1024;
const DEFAULT_BUFFERED_AMOUNT_POLL_MS = 4;
const NORMAL_CLOSE_CODE = 1000;
const INTERNAL_ERROR_CLOSE_CODE = 4500;
const textEncoder = new TextEncoder();

export type Frame = string | Uint8Array;

export type ConnectionClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type FrameSendOptions = Readonly<{
  signal?: AbortSignal;
  /** @internal Runs at the physical emission boundary after backpressure. */
  beforeSend?(): void;
}>;

/**
 * Bounded transport-neutral connection consumed by the protocol kernel.
 *
 * Native socket events and addressed local-fabric events are normalized before
 * they cross this boundary. Protocol and lifecycle code therefore never needs
 * to know which physical transport owns the connection.
 */
export type FrameConnection = Readonly<{
  id: string;
  protocol: string;
  incoming: ReadableStream<Frame>;
  send(frame: Frame, options?: FrameSendOptions): Promise<void>;
  close(reason?: string, code?: number): void;
  closed: Promise<ConnectionClose>;
}>;

export type FrameConnectionOptions = Readonly<{
  id?: string;
  negotiatedProtocol?: string;
  signal?: AbortSignal;
  maxInboundFrames?: number;
  maxInboundBytes?: number;
  maxPendingSendFrames?: number;
  maxPendingSendBytes?: number;
  maxBufferedAmountBytes?: number;
  bufferedAmountLowWaterBytes?: number;
  bufferedAmountPollMs?: number;
}>;

type BoundedFrameQueue = Readonly<{
  readable: ReadableStream<Frame>;
  push(frame: Frame): boolean;
  close(error?: unknown): void;
}>;

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== "number" ||
    !Number.isSafeInteger(selected) ||
    selected < 1
  ) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return selected;
}

function frameBytes(frame: Frame): number {
  return typeof frame === "string"
    ? textEncoder.encode(frame).byteLength
    : frame.byteLength;
}

async function normalizeFrame(value: SocketMessage): Promise<Frame> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  throw new TypeError("connection produced an unsupported frame value");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createBoundedFrameQueue(
  limits: Readonly<{ frames: number; bytes: number }>,
  cancel: (reason: unknown) => void,
): BoundedFrameQueue {
  const pending: Frame[] = [];
  let pendingBytes = 0;
  let controller: ReadableStreamDefaultController<Frame> | undefined;
  let closed = false;
  let ending = false;

  const finishEnd = (): void => {
    if (!ending || closed || pending.length > 0 || controller === undefined) {
      return;
    }
    closed = true;
    try {
      controller.close();
    } catch {
      // A consumer may already have cancelled the stream.
    }
    controller = undefined;
  };

  const flush = (): void => {
    while (
      !closed &&
      controller !== undefined &&
      pending.length > 0 &&
      (controller.desiredSize ?? 0) > 0
    ) {
      const frame = pending.shift()!;
      pendingBytes -= frameBytes(frame);
      controller.enqueue(frame);
    }
    finishEnd();
  };

  const readable = new ReadableStream<Frame>({
    start(value) {
      controller = value;
      flush();
    },
    pull() {
      flush();
    },
    cancel(reason) {
      if (closed) return;
      closed = true;
      pending.length = 0;
      pendingBytes = 0;
      controller = undefined;
      cancel(reason);
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 }));

  const push = (frame: Frame): boolean => {
    if (closed || ending) return false;
    const bytes = frameBytes(frame);
    if (bytes < 1) return false;
    const controllerFrame = (controller?.desiredSize ?? 1) <= 0 ? 1 : 0;
    if (
      pending.length + controllerFrame >= limits.frames ||
      bytes > limits.bytes - pendingBytes
    ) {
      return false;
    }
    pending.push(frame);
    pendingBytes += bytes;
    flush();
    return true;
  };

  const close = (error?: unknown): void => {
    if (closed || ending) return;
    if (error === undefined) {
      ending = true;
      flush();
      finishEnd();
      return;
    }
    closed = true;
    pending.length = 0;
    pendingBytes = 0;
    if (controller !== undefined) {
      try {
        controller.error(error);
      } catch {
        // A consumer may already have cancelled the stream.
      }
    }
    controller = undefined;
  };

  return Object.freeze({ readable, push, close });
}

function closeWire(
  connection: SocketConnection,
  code: number,
  reason: string,
): void {
  if (connection.state !== "connecting" && connection.state !== "open") return;
  try {
    connection.close(code, reason);
  } catch {
    try {
      connection.close();
    } catch {
      // The native close/error event remains authoritative.
    }
  }
}

/**
 * Normalizes a runtime socket/event adapter into the canonical frame stream.
 * All native callbacks end here; downstream protocol code consumes Web Streams.
 */
export async function createFrameConnection(
  connection: SocketConnection,
  options: FrameConnectionOptions = {},
): Promise<FrameConnection> {
  const maxInboundFrames = positiveInteger(
    options.maxInboundFrames,
    DEFAULT_MAX_INBOUND_FRAMES,
    "maxInboundFrames",
  );
  const maxInboundBytes = positiveInteger(
    options.maxInboundBytes,
    DEFAULT_MAX_INBOUND_BYTES,
    "maxInboundBytes",
  );
  const maxPendingSendFrames = positiveInteger(
    options.maxPendingSendFrames,
    DEFAULT_MAX_PENDING_SEND_FRAMES,
    "maxPendingSendFrames",
  );
  const maxPendingSendBytes = positiveInteger(
    options.maxPendingSendBytes,
    DEFAULT_MAX_PENDING_SEND_BYTES,
    "maxPendingSendBytes",
  );
  const maxBufferedAmountBytes = positiveInteger(
    options.maxBufferedAmountBytes,
    DEFAULT_MAX_BUFFERED_AMOUNT_BYTES,
    "maxBufferedAmountBytes",
  );
  const bufferedAmountLowWaterBytes = positiveInteger(
    options.bufferedAmountLowWaterBytes,
    DEFAULT_BUFFERED_AMOUNT_LOW_WATER_BYTES,
    "bufferedAmountLowWaterBytes",
  );
  const bufferedAmountPollMs = positiveInteger(
    options.bufferedAmountPollMs,
    DEFAULT_BUFFERED_AMOUNT_POLL_MS,
    "bufferedAmountPollMs",
  );
  if (bufferedAmountLowWaterBytes >= maxBufferedAmountBytes) {
    throw new TypeError(
      "bufferedAmountLowWaterBytes must be less than maxBufferedAmountBytes",
    );
  }
  options.signal?.throwIfAborted();

  let terminal = false;
  let opened = connection.state === "open";
  let openResolve!: () => void;
  let openReject!: (error: unknown) => void;
  const open = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  if (opened) openResolve();

  let closedResolve!: (close: ConnectionClose) => void;
  const closed = new Promise<ConnectionClose>((resolve) => {
    closedResolve = resolve;
  });
  const queue = createBoundedFrameQueue(
    { frames: maxInboundFrames, bytes: maxInboundBytes },
    (reason) =>
      closeWire(
        connection,
        NORMAL_CLOSE_CODE,
        typeof reason === "string" ? reason : "incoming_cancelled",
      ),
  );
  let inboundTail = Promise.resolve();
  let unsubscribe = (): void => undefined;
  let abort = (): void => undefined;

  const finish = (event: SocketClose, error?: unknown): void => {
    if (terminal) return;
    terminal = true;
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    if (!opened) {
      openReject(
        error ?? new TypeError(
          `connection closed before opening (${event.code}: ${event.reason})`,
        ),
      );
    }
    queue.close(error);
    closedResolve(Object.freeze({
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    }));
  };

  const receive = (value: SocketMessage): void => {
    if (terminal) return;
    inboundTail = inboundTail.then(async () => {
      if (terminal) return;
      try {
        const frame = await normalizeFrame(value);
        if (!queue.push(frame)) {
          const error = new RangeError(
            "connection inbound frame queue exceeded its bound",
          );
          closeWire(connection, INTERNAL_ERROR_CLOSE_CODE, "inbound_overflow");
          finish({
            code: INTERNAL_ERROR_CLOSE_CODE,
            reason: "inbound_overflow",
            wasClean: false,
          }, error);
        }
      } catch (error) {
        closeWire(connection, INTERNAL_ERROR_CLOSE_CODE, "invalid_frame");
        finish({
          code: INTERNAL_ERROR_CLOSE_CODE,
          reason: "invalid_frame",
          wasClean: false,
        }, error);
      }
    });
  };

  abort = (): void => {
    const reason = options.signal?.reason;
    closeWire(connection, NORMAL_CLOSE_CODE, "connection_aborted");
    finish({
      code: NORMAL_CLOSE_CODE,
      reason: "connection_aborted",
      wasClean: true,
    }, reason);
  };

  unsubscribe = connection.subscribe({
    open() {
      if (terminal || opened) return;
      opened = true;
      openResolve();
    },
    message: receive,
    close(event) {
      void inboundTail.finally(() => finish(event));
    },
    error(error) {
      const failure = error ?? new TypeError("connection transport failed");
      closeWire(connection, INTERNAL_ERROR_CLOSE_CODE, "transport_failed");
      finish({
        code: INTERNAL_ERROR_CLOSE_CODE,
        reason: "transport_failed",
        wasClean: false,
      }, failure);
    },
  });

  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();

  if (connection.state !== "connecting" && connection.state !== "open") {
    finish({ code: 1006, reason: "connection_not_open", wasClean: false });
  }
  await open;
  const protocol = connection.protocol || options.negotiatedProtocol;
  if (
    typeof protocol !== "string" ||
    protocol.length === 0 ||
    (connection.protocol !== "" &&
      options.negotiatedProtocol !== undefined &&
      connection.protocol !== options.negotiatedProtocol)
  ) {
    closeWire(connection, 4400, "unsupported_protocol");
    throw new TypeError("connection did not negotiate an exact protocol");
  }

  let sendTail = Promise.resolve();
  let pendingSendFrames = 0;
  let pendingSendBytes = 0;

  const send = (
    frame: Frame,
    sendOptions: FrameSendOptions = {},
  ): Promise<void> => {
    const bytes = frameBytes(frame);
    if (bytes < 1) {
      return Promise.reject(new TypeError("frame must not be empty"));
    }
    if (
      pendingSendFrames >= maxPendingSendFrames ||
      bytes > maxPendingSendBytes - pendingSendBytes
    ) {
      return Promise.reject(
        new RangeError("connection send queue exceeded its bound"),
      );
    }
    pendingSendFrames++;
    pendingSendBytes += bytes;
    const operation = sendTail.then(async () => {
      let throttled = false;
      while (true) {
        if (terminal || connection.state !== "open") {
          throw new TypeError("connection is closed");
        }
        sendOptions.signal?.throwIfAborted();
        options.signal?.throwIfAborted();
        const room = maxBufferedAmountBytes - bytes;
        if (room < 0) {
          throw new RangeError(
            "frame exceeds the connection buffered-amount limit",
          );
        }
        const threshold = throttled
          ? Math.min(bufferedAmountLowWaterBytes, room)
          : room;
        if (connection.bufferedAmount <= threshold) break;
        throttled = true;
        await delay(bufferedAmountPollMs, sendOptions.signal ?? options.signal);
      }
      sendOptions.beforeSend?.();
      connection.send(frame);
    });
    sendTail = operation.catch(() => undefined);
    return operation.finally(() => {
      pendingSendFrames--;
      pendingSendBytes -= bytes;
    });
  };

  return Object.freeze({
    id: options.id ?? crypto.randomUUID(),
    protocol,
    incoming: queue.readable,
    send,
    close(reason = "connection_closed", code = NORMAL_CLOSE_CODE) {
      closeWire(connection, code, reason);
    },
    closed,
  });
}
