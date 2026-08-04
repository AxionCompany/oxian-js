import type {
  ControlFrame,
  ProtocolFrameAcceptance,
  ProtocolOrderValidatorOptions,
  ProtocolRole,
  ProtocolStateSnapshot,
  WorkDataFrame,
} from "../protocol/index.ts";

export type TransportSendOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type TransportCloseOptions = Readonly<{
  code?: number;
  reason?: string;
  timeoutMs?: number;
}>;

export type WebSocketTransportClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type WebSocketTransportMessage =
  | Readonly<{
    kind: "control";
    acceptance: ProtocolFrameAcceptance<ControlFrame>;
    wireBytes: number;
  }>
  | Readonly<{
    kind: "data";
    acceptance: ProtocolFrameAcceptance<WorkDataFrame>;
    wireBytes: number;
  }>;

/** Runtime-neutral lifecycle state for one worker wire connection. */
export type WorkerWireConnectionState =
  | "connecting"
  | "open"
  | "closing"
  | "closed";

export type WorkerWireMessageData =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob;

export type WorkerWireClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type WorkerWireObserver = Readonly<{
  open?(): void;
  message?(data: WorkerWireMessageData): void;
  close?(event: WorkerWireClose): void;
  error?(error?: unknown): void;
}>;

/**
 * Callback-based connection contract shared by runtime server adapters.
 *
 * It deliberately does not extend EventTarget: some server runtimes deliver
 * WebSocket events through server/object-level callbacks instead of per-socket
 * DOM events.
 */
export type WorkerWireConnection = Readonly<{
  readonly protocol: string;
  readonly state: WorkerWireConnectionState;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  subscribe(observer: WorkerWireObserver): () => void;
}>;

export type WebSocketTransportOptions = Readonly<{
  /**
   * Native client WebSockets remain accepted for compatibility. Server
   * adapters should pass an explicit WorkerWireConnection.
   */
  socket: WebSocket | WorkerWireConnection;
  role: ProtocolRole;
  /**
   * Server adapters may supply the exact protocol they selected when their
   * WebSocket implementation does not expose it on `socket.protocol`.
   */
  negotiatedProtocol?: string;
  signal?: AbortSignal;
  maxInboundMessages?: number;
  maxInboundBytes?: number;
  maxPendingSendMessages?: number;
  maxPendingSendBytes?: number;
  maxBufferedAmountBytes?: number;
  bufferedAmountLowWaterBytes?: number;
  bufferedAmountPollMs?: number;
  /**
   * Optional connection-local admission limits. Wire hard limits still apply.
   */
  protocol?: Omit<ProtocolOrderValidatorOptions, "role">;
}>;

export type WebSocketTransport = Readonly<{
  sendControl(
    frame: ControlFrame,
    options?: TransportSendOptions,
  ): Promise<ProtocolFrameAcceptance<ControlFrame>>;
  sendData(
    frame: WorkDataFrame,
    options?: TransportSendOptions,
  ): Promise<ProtocolFrameAcceptance<WorkDataFrame>>;
  /**
   * Returns the single-consumer inbound message iterable.
   */
  messages(): AsyncIterable<WebSocketTransportMessage>;
  snapshot(): ProtocolStateSnapshot;
  close(options?: TransportCloseOptions): Promise<void>;
  readonly closed: Promise<WebSocketTransportClose>;
}>;

export type WorkerWebSocketFactoryContext = Readonly<{
  /**
   * The already validated worker endpoint.
   */
  url: URL;
  /**
   * The exact Oxian worker subprotocol the socket must negotiate.
   */
  protocol: string;
  /**
   * Covers both caller cancellation and the connection deadline.
   */
  signal: AbortSignal;
}>;

/**
 * Creates the native outbound socket after any provider-owned authentication.
 *
 * A factory may asynchronously obtain a short-lived identity token and attach
 * provider-specific headers. Oxian still validates the URL, owns the deadline,
 * waits for Open, and verifies the negotiated worker subprotocol.
 */
export type WorkerWebSocketFactory = (
  context: WorkerWebSocketFactoryContext,
) => WebSocket | Promise<WebSocket>;

export type ConnectWorkerWebSocketOptions = Readonly<{
  url: string | URL;
  signal?: AbortSignal;
  timeoutMs?: number;
  createWebSocket?: WorkerWebSocketFactory;
  /**
   * Permits `ws:` only for loopback integration tests and local development.
   */
  allowInsecureLoopback?: boolean;
}>;
