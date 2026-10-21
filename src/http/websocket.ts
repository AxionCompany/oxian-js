import type { SocketConnection } from "../transport/types.ts";

/** Hard per-route socket bounds, independent of worker transport credit. */
export const ROUTE_WEBSOCKET_LIMITS: Readonly<{
  messageBytes: number;
  queuedBytes: number;
  queuedMessages: number;
}> = Object.freeze({
  messageBytes: 256 * 1024,
  queuedBytes: 1024 * 1024,
  queuedMessages: 64,
});
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const addresses = new WeakMap<Request, string>();
const acceptances = new WeakMap<Response, RouteWebSocketSession>();

/** Trusted listener peer address; never inferred from forwarding headers. */
export function getClientAddress(request: Request): string | undefined {
  return addresses.get(request);
}

export function setClientAddress(request: Request, address: string): void {
  addresses.set(request, address);
}

export function isWebSocketRequest(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  );
}

function validClose(code: number): boolean {
  return (
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  );
}

/** A route socket whose lifetime is owned by its HTTP workload. */
export type RouteWebSocket = {
  readonly protocol: string;
  readonly url: string;
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: "arraybuffer" | "blob";
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
  close(code?: number, reason?: string): void;
};

type RouteWebSocketSession = RouteWebSocket & {
  readonly request: Request;
  readonly output: ReadableStream<Uint8Array>;
  selectProtocol(protocol: string): void;
  activate(): void;
  fail(code?: number, reason?: string): void;
  receive(input: ReadableStream<Uint8Array>): Promise<void>;
  attach(connection: SocketConnection): void;
};

export function createRouteWebSocket(
  request: Request,
  protocol: string,
): RouteWebSocketSession {
  const events = new EventTarget();
  let selectedProtocol = protocol;
  let readyState = 0;
  let outputController!: ReadableStreamDefaultController<Uint8Array>;
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let demand = false;
  let ended = false;
  const cleanups = new Set<() => void>();
  const output = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        outputController = controller;
      },
      pull() {
        demand = true;
        flush();
      },
      cancel() {
        // The work transport may cancel this half after the peer's response
        // ends. Its close envelope can still be waiting in the other half.
        ended = true;
        queue = [];
        queuedBytes = 0;
      },
    },
    { highWaterMark: 0 },
  );
  function selectProtocol(protocol: string): void {
    const offered =
      request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((value) => value.trim()) ?? [];
    if (protocol && !offered.includes(protocol))
      throw new TypeError("WebSocket protocol was not offered");
    selectedProtocol = protocol;
  }

  function activate(): void {
    if (readyState !== 0) return;
    readyState = 1;
    const event = new Event("open");
    events.dispatchEvent(event);
    socket.onopen?.(event);
  }

  function send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    if (readyState !== 1 || ended)
      throw new DOMException("Socket is not open", "InvalidStateError");
    // Blob conversion is asynchronous; accepting it here could create an
    // unbounded promise queue before byte accounting. Use ArrayBuffer instead.
    if (data instanceof Blob)
      throw new TypeError("Use text or ArrayBuffer for route socket messages");
    if (
      typeof data === "string" &&
      data.length > ROUTE_WEBSOCKET_LIMITS.messageBytes
    ) {
      fail(1009, "Route message too large");
      return;
    }
    const bytes =
      typeof data === "string"
        ? encoder.encode(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
    enqueue(typeof data === "string" ? 1 : 2, bytes);
  }

  function close(code = 1000, reason = ""): void {
    if (!validClose(code) || encoder.encode(reason).length > 123)
      throw new TypeError("Invalid WebSocket close code or reason");
    if (readyState >= 2) return;
    const bytes = new Uint8Array(2 + encoder.encode(reason).length);
    new DataView(bytes.buffer).setUint16(0, code);
    bytes.set(encoder.encode(reason), 2);
    enqueue(8, bytes);
    finish(code, reason, true);
  }

  function fail(code = 1011, reason = "Route socket failed"): void {
    if (readyState >= 2) return;
    queue = [];
    queuedBytes = 0;
    try {
      const event = new Event("error");
      events.dispatchEvent(event);
      socket.onerror?.(event);
    } finally {
      close(code, reason);
    }
  }

  function finish(code: number, reason: string, wasClean: boolean): void {
    if (readyState >= 2) return;
    readyState = 3;
    flush();
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    const event = new CloseEvent("close", { code, reason, wasClean });
    events.dispatchEvent(event);
    socket.onclose?.(event);
  }

  function enqueue(type: number, bytes: Uint8Array): void {
    if (
      bytes.length > ROUTE_WEBSOCKET_LIMITS.messageBytes ||
      queue.length >= ROUTE_WEBSOCKET_LIMITS.queuedMessages ||
      queuedBytes + bytes.length + 5 > ROUTE_WEBSOCKET_LIMITS.queuedBytes
    ) {
      fail(1009, "Route socket buffer exceeded");
      return;
    }
    const frame = new Uint8Array(bytes.length + 5);
    frame[0] = type;
    new DataView(frame.buffer).setUint32(1, bytes.length);
    frame.set(bytes, 5);
    queue.push(frame);
    queuedBytes += frame.length;
    flush();
  }

  function flush(): void {
    if (ended) return;
    if (demand && queue.length) {
      const frame = queue.shift()!;
      queuedBytes -= frame.length;
      demand = false;
      outputController.enqueue(frame);
    }
    if (readyState === 3 && !queue.length) {
      ended = true;
      outputController.close();
    }
  }

  /** Decode one bounded envelope at a time; work chunks need not align. */
  async function receive(input: ReadableStream<Uint8Array>): Promise<void> {
    const reader = input.getReader();
    let chunk = new Uint8Array(0),
      offset = 0;
    const read = async (length: number): Promise<Uint8Array<ArrayBuffer>> => {
      const bytes = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        if (offset === chunk.length) {
          const next = await reader.read();
          if (next.done) throw new Error("Socket stream ended without close");
          chunk = next.value as Uint8Array<ArrayBuffer>;
          offset = 0;
        }
        const size = Math.min(length - copied, chunk.length - offset);
        bytes.set(chunk.subarray(offset, offset + size), copied);
        copied += size;
        offset += size;
      }
      return bytes;
    };
    let closed = false;
    try {
      while (true) {
        const header = await read(5);
        const type = header[0];
        const length = new DataView(header.buffer).getUint32(1);
        if (length > ROUTE_WEBSOCKET_LIMITS.messageBytes) {
          fail(1009, "Route message too large");
          break;
        }
        if (
          ![1, 2, 8].includes(type!) ||
          (type === 8 && (length < 2 || length > 125))
        )
          throw new Error("Invalid socket envelope");
        const bytes = await read(length);
        if (type === 8) {
          const code = new DataView(bytes.buffer).getUint16(0);
          const reason = decoder.decode(bytes.subarray(2));
          if (!validClose(code)) throw new Error("Invalid close code");
          close(code, reason);
          closed = true;
          // Consume the terminal EOF so normal close does not cancel work.
          if (offset !== chunk.length)
            throw new Error("Data after socket close");
          const tail = await reader.read();
          if (!tail.done) throw new Error("Data after socket close");
          break;
        }
        const data =
          type === 1
            ? decoder.decode(bytes)
            : socket.binaryType === "blob"
              ? new Blob([bytes])
              : bytes.buffer;
        const event = new MessageEvent("message", { data });
        events.dispatchEvent(event);
        socket.onmessage?.(event);
      }
    } catch {
      fail();
    } finally {
      if (!closed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  /** Connect the route endpoint to a native listener or native worker socket. */
  function attach(connection: SocketConnection): void {
    let pendingClose: { code: number; reason: string } | undefined =
      readyState >= 2
        ? { code: 1011, reason: "Route socket cancelled" }
        : undefined;
    let attached = false;
    const open = () => {
      if (pendingClose) {
        unsubscribe();
        connection.close(pendingClose.code, pendingClose.reason);
        return;
      }
      if (attached || readyState >= 2) return;
      attached = true;
      activate();
    };
    const unsubscribe = connection.subscribe({
      open,
      message: (data) => {
        try {
          send(data);
        } catch {
          fail();
        }
      },
      close: ({ code, reason }) => {
        unsubscribe();
        close(validClose(code) ? code : code === 1005 ? 1000 : 1011, reason);
      },
      error: () => fail(),
    });
    const message = (event: Event) => {
      const data = (event as MessageEvent).data as string | ArrayBuffer;
      if (
        typeof data === "string" &&
        data.length > ROUTE_WEBSOCKET_LIMITS.messageBytes
      ) {
        fail(1009, "Route message too large");
        return;
      }
      const bytes =
        typeof data === "string"
          ? encoder.encode(data).length
          : data.byteLength;
      if (
        connection.bufferedAmount + bytes >
        ROUTE_WEBSOCKET_LIMITS.queuedBytes
      ) {
        fail(1009, "Native socket buffer exceeded");
        return;
      }
      try {
        connection.send(typeof data === "string" ? data : new Uint8Array(data));
      } catch {
        fail();
      }
    };
    events.addEventListener("message", message);
    events.addEventListener(
      "close",
      (event) => {
        events.removeEventListener("message", message);
        const close = event as CloseEvent;
        if (connection.state === "connecting") {
          pendingClose = { code: close.code, reason: close.reason };
        } else {
          unsubscribe();
          connection.close(close.code, close.reason);
        }
      },
      { once: true },
    );
    if (connection.state === "open") open();
  }
  const socket: RouteWebSocketSession = {
    get protocol() {
      return selectedProtocol;
    },
    url: request.url,
    request,
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return queuedBytes;
    },
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    send,
    close,
    output,
    selectProtocol,
    activate,
    fail,
    receive,
    attach,
  };
  const abort = () => fail();
  request.signal.addEventListener("abort", abort, { once: true });
  cleanups.add(() => request.signal.removeEventListener("abort", abort));
  if (request.signal.aborted) fail();
  return socket;
}

/** Accept a route upgrade. Return this response unchanged from the handler. */
export function upgradeWebSocket(
  request: Request,
  options: Readonly<{ protocol?: string }> = {},
): Readonly<{ socket: RouteWebSocket; response: Response }> {
  if (!isWebSocketRequest(request))
    throw new TypeError("Expected a WebSocket upgrade request");
  const protocol = options.protocol ?? "";
  const offered =
    request.headers
      .get("sec-websocket-protocol")
      ?.split(",")
      .map((value) => value.trim()) ?? [];
  if (protocol && !offered.includes(protocol))
    throw new TypeError("WebSocket protocol was not offered");
  const socket = createRouteWebSocket(request, protocol);
  const response = new Response(null, { status: 204 });
  Object.defineProperties(response, {
    status: { value: 101 },
    statusText: { value: "Switching Protocols" },
    ok: { value: false },
  });
  acceptances.set(response, socket);
  return Object.freeze({ socket, response });
}

export function acceptedWebSocket(
  response: Response,
): RouteWebSocketSession | undefined {
  return acceptances.get(response);
}
