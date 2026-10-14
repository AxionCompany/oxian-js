import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import {
  createReadyAckFrame,
  createWelcomeFrame,
  type HelloFrame,
  type JsonObject,
  type ReadyFrame,
  type WelcomeFrame,
  WORKER_PROTOCOL,
} from "../../src/protocol/index.ts";
import {
  adaptSocketConnection,
  createFrameConnection,
  createProtocolTransport,
  type ProtocolTransport,
  type ProtocolTransportMessage,
} from "../../src/transport/index.ts";

export type TestPeerConnection = Readonly<{
  socket: WebSocket;
  transport: ProtocolTransport;
  iterator: AsyncIterator<ProtocolTransportMessage>;
}>;

export type TestPeer = Readonly<{
  url: string;
  nextConnection(timeoutMs?: number): Promise<TestPeerConnection>;
  connectionCount(): number;
  close(): Promise<void>;
}>;

export type TestHandshake = Readonly<{
  hello: HelloFrame;
  ready: ReadyFrame;
  welcome: WelcomeFrame;
}>;

type Waiter = Readonly<{
  resolve(connection: TestPeerConnection): void;
  reject(error: unknown): void;
}>;

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 2_000,
  message = "test operation timed out",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(message, "TimeoutError")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function startTestPeer(): Promise<TestPeer> {
  const pending: TestPeerConnection[] = [];
  const waiters: Waiter[] = [];
  const transports = new Set<ProtocolTransport>();
  let terminalError: unknown;
  let connectionCount = 0;

  const deliver = (connection: TestPeerConnection): void => {
    connectionCount++;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(connection);
    else pending.push(connection);
  };

  const fail = (error: unknown): void => {
    terminalError ??= error;
    while (waiters.length > 0) waiters.shift()?.reject(error);
  };

  const sockets = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (offered) =>
      offered.has(WORKER_PROTOCOL) ? WORKER_PROTOCOL : false,
  });
  const server = createServer((_request, response) => {
    response.writeHead(426).end("exact worker subprotocol required");
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers["sec-websocket-protocol"] !== WORKER_PROTOCOL) {
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const socket = ws as unknown as WebSocket;
      void createFrameConnection(adaptSocketConnection(socket), {
        negotiatedProtocol: WORKER_PROTOCOL,
      })
        .then((connection) =>
          createProtocolTransport({ connection, role: "hypervisor" }),
        )
        .then((transport) => {
          transports.add(transport);
          transport.closed.then(() => transports.delete(transport));
          deliver({
            socket,
            transport,
            iterator: transport.messages()[Symbol.asyncIterator](),
          });
        })
        .catch(fail);
    });
  });
  server.on("error", fail);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  const nextConnection = (timeoutMs = 2_000): Promise<TestPeerConnection> => {
    const connection = pending.shift();
    if (connection !== undefined) return Promise.resolve(connection);
    if (terminalError !== undefined) return Promise.reject(terminalError);
    return withTimeout(
      new Promise<TestPeerConnection>((resolve, reject) => {
        waiters.push({ resolve, reject });
      }),
      timeoutMs,
      "worker did not open a WebSocket",
    );
  };

  const close = async (): Promise<void> => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new DOMException("test peer closed", "AbortError"));
    }
    await Promise.all(
      Array.from(transports, (transport) =>
        transport
          .close({
            code: 1000,
            reason: "test_complete",
            timeoutMs: 250,
          })
          .catch(() => undefined),
      ),
    );
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };

  return Object.freeze({
    url: `ws://127.0.0.1:${address.port}/workers`,
    nextConnection,
    connectionCount: () => connectionCount,
    close,
  });
}

export async function nextMessage(
  connection: TestPeerConnection,
  timeoutMs = 2_000,
): Promise<ProtocolTransportMessage> {
  const result = await withTimeout(
    connection.iterator.next(),
    timeoutMs,
    "worker message timed out",
  );
  if (result.done) {
    const close = await connection.transport.closed;
    throw new TypeError(
      `worker connection ended before its next message (${close.code}: ${close.reason})`,
    );
  }
  return result.value;
}

export async function nextControl(
  connection: TestPeerConnection,
  type?: string,
  timeoutMs = 2_000,
): Promise<Extract<ProtocolTransportMessage, { kind: "control" }>> {
  while (true) {
    const message = await nextMessage(connection, timeoutMs);
    if (message.kind !== "control") continue;
    if (type === undefined || message.acceptance.frame.type === type) {
      return message;
    }
  }
}

export async function acceptTestHandshake(
  connection: TestPeerConnection,
  options: Readonly<{
    connectionId?: string;
    resumeCapability?: string;
    resumeExpiresAtMs?: number;
    bootstrap?: JsonObject;
    heartbeatIntervalMs?: number;
    leaseTimeoutMs?: number;
  }> = {},
): Promise<TestHandshake> {
  const helloMessage = await nextControl(connection, "hello");
  const hello = helloMessage.acceptance.frame as HelloFrame;
  const welcome = createWelcomeFrame({
    connectionId: options.connectionId ?? crypto.randomUUID(),
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 1_000,
    leaseTimeoutMs: options.leaseTimeoutMs ?? 5_000,
    resumeCapability: options.resumeCapability ?? crypto.randomUUID(),
    resumeExpiresAtMs: options.resumeExpiresAtMs ?? Date.now() + 10 * 60_000,
    bootstrap: options.bootstrap ?? {},
  });
  await connection.transport.sendControl(welcome);
  const readyMessage = await nextControl(connection, "ready");
  const ready = readyMessage.acceptance.frame as ReadyFrame;
  await connection.transport.sendControl(
    createReadyAckFrame({
      connectionId: welcome.connectionId,
    }),
  );
  return { hello, ready, welcome };
}
