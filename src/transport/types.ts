import type {
  ControlFrame,
  ProtocolFrameAcceptance,
  ProtocolOrderValidatorOptions,
  ProtocolRole,
  ProtocolStateSnapshot,
  WorkDataFrame,
} from "../protocol/index.ts";
import type { ConnectionClose, FrameConnection } from "./frame.ts";

export type TransportSendOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type TransportCloseOptions = Readonly<{
  code?: number;
  reason?: string;
  timeoutMs?: number;
}>;

export type ProtocolTransportMessage =
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
export type SocketConnectionState =
  | "connecting"
  | "open"
  | "closing"
  | "closed";

export type SocketMessage =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob;

export type SocketClose = Readonly<{
  code: number;
  reason: string;
  wasClean: boolean;
}>;

export type SocketObserver = Readonly<{
  open?(): void;
  message?(data: SocketMessage): void;
  close?(event: SocketClose): void;
  error?(error?: unknown): void;
}>;

/**
 * Callback-based connection contract shared by runtime server adapters.
 *
 * It deliberately does not extend EventTarget: some server runtimes deliver
 * WebSocket events through server/object-level callbacks instead of per-socket
 * DOM events.
 */
export type SocketConnection = Readonly<{
  readonly protocol: string;
  readonly state: SocketConnectionState;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  subscribe(observer: SocketObserver): () => void;
}>;

export type ProtocolTransportOptions = Readonly<{
  connection: FrameConnection;
  role: ProtocolRole;
  signal?: AbortSignal;
  maxInboundMessages?: number;
  maxInboundBytes?: number;
  maxPendingSendMessages?: number;
  maxPendingSendBytes?: number;
  /**
   * Optional connection-local admission limits. Wire hard limits still apply.
   */
  protocol?: Omit<ProtocolOrderValidatorOptions, "role">;
}>;

export type ProtocolTransport = Readonly<{
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
  messages(): AsyncIterable<ProtocolTransportMessage>;
  snapshot(): ProtocolStateSnapshot;
  close(options?: TransportCloseOptions): Promise<void>;
  readonly closed: Promise<ConnectionClose>;
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
