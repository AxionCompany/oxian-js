import type {
  SocketConnection,
  SocketConnectionState,
  SocketObserver,
} from "./types.ts";

function stateOf(socket: WebSocket): SocketConnectionState {
  switch (socket.readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      throw new TypeError("WebSocket exposed an invalid readyState");
  }
}

/** Adapts a standards-compatible WebSocket to Oxian's wire contract. */
export function adaptWebSocket(
  socket: WebSocket,
): SocketConnection {
  if (
    socket === null ||
    typeof socket !== "object" ||
    typeof socket.addEventListener !== "function" ||
    typeof socket.removeEventListener !== "function" ||
    typeof socket.send !== "function" ||
    typeof socket.close !== "function"
  ) {
    throw new TypeError("socket must be a standards-compatible WebSocket");
  }
  try {
    socket.binaryType = "arraybuffer";
  } catch (cause) {
    throw new TypeError("socket does not support binary WebSocket messages", {
      cause,
    });
  }

  const connection: SocketConnection = {
    get protocol() {
      return socket.protocol;
    },
    get state() {
      return stateOf(socket);
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    subscribe(observer: SocketObserver): () => void {
      if (observer === null || typeof observer !== "object") {
        throw new TypeError("wire observer must be an object");
      }
      const open = (): void => observer.open?.();
      const message = (event: MessageEvent): void =>
        observer.message?.(event.data);
      const close = (event: CloseEvent): void =>
        observer.close?.(Object.freeze({
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        }));
      const error = (event: Event): void => observer.error?.(event);
      socket.addEventListener("open", open);
      socket.addEventListener("message", message);
      socket.addEventListener("close", close);
      socket.addEventListener("error", error);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        socket.removeEventListener("open", open);
        socket.removeEventListener("message", message);
        socket.removeEventListener("close", close);
        socket.removeEventListener("error", error);
      };
    },
  };
  return Object.freeze(connection);
}

export function isSocketConnection(
  value: unknown,
): value is SocketConnection {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<SocketConnection>;
  return typeof candidate.protocol === "string" &&
    (candidate.state === "connecting" ||
      candidate.state === "open" ||
      candidate.state === "closing" ||
      candidate.state === "closed") &&
    typeof candidate.bufferedAmount === "number" &&
    typeof candidate.send === "function" &&
    typeof candidate.close === "function" &&
    typeof candidate.subscribe === "function";
}

export function expectSocketConnection(
  value: unknown,
): SocketConnection {
  if (!isSocketConnection(value)) {
    throw new TypeError("connection must implement SocketConnection");
  }
  return value;
}

export function adaptSocketConnection(
  value: WebSocket | SocketConnection,
): SocketConnection {
  return isSocketConnection(value) ? value : adaptWebSocket(value);
}
