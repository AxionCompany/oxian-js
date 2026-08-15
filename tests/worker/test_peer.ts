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

export function startTestPeer(): Promise<TestPeer> {
  const abortController = new AbortController();
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

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abortController.signal,
    onListen: () => undefined,
    onError: (error) => {
      fail(error);
      return new Response("test peer failed", { status: 500 });
    },
  }, (request) => {
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      request.headers.get("sec-websocket-protocol") !== WORKER_PROTOCOL
    ) {
      return new Response("exact worker subprotocol required", {
        status: 426,
      });
    }
    const { socket, response } = Deno.upgradeWebSocket(request, {
      protocol: WORKER_PROTOCOL,
    });
    socket.addEventListener("open", () => {
      void createFrameConnection(adaptSocketConnection(socket), {
        negotiatedProtocol: WORKER_PROTOCOL,
      }).then((connection) =>
        Promise.resolve(createProtocolTransport({
          connection,
          role: "hypervisor",
        }))
      ).then((transport) => {
        transports.add(transport);
        transport.closed.then(() => transports.delete(transport));
        deliver({
          socket,
          transport,
          iterator: transport.messages()[Symbol.asyncIterator](),
        });
      }).catch(fail);
    }, { once: true });
    return response;
  });

  const address = server.addr;
  if (address.transport !== "tcp") {
    abortController.abort();
    throw new TypeError("test peer did not bind TCP");
  }

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
      Array.from(
        transports,
        (transport) =>
          transport.close({
            code: 1000,
            reason: "test_complete",
            timeoutMs: 250,
          }).catch(() => undefined),
      ),
    );
    abortController.abort();
    await server.finished.catch(() => undefined);
  };

  return Promise.resolve(Object.freeze({
    url: `ws://127.0.0.1:${address.port}/workers`,
    nextConnection,
    connectionCount: () => connectionCount,
    close,
  }));
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
  await connection.transport.sendControl(createReadyAckFrame({
    connectionId: welcome.connectionId,
  }));
  return { hello, ready, welcome };
}
