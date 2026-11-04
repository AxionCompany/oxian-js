import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects } from "../support/assert.ts";
import {
  BINARY_PROTOCOL,
  createHelloFrame,
  encodeControlFrame,
  WORKER_PROTOCOL,
} from "../../src/protocol/index.ts";
import { createBoundedAsyncQueue } from "../../src/transport/queue.ts";
import {
  adaptSocketConnection,
  connectWorkerWebSocket,
  createFrameConnection,
  createProtocolTransport,
  type ProtocolTransportOptions,
  type SocketClose,
  type SocketConnection,
  type SocketObserver,
} from "../../src/transport/index.ts";
import {
  nextControl,
  startTestPeer,
  withTimeout,
} from "../worker/test_peer.ts";

const HELLO = createHelloFrame({
  handshakeId: "handshake-1",
  identity: {
    workerId: "transport-worker",
    attemptId: "attempt-1",
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: "registration-1",
  },
  workloads: ["echo"],
  capacity: 1,
});

type TestTransportOptions = Omit<ProtocolTransportOptions, "connection"> &
  Readonly<{
    socket: WebSocket | SocketConnection;
    negotiatedProtocol?: string;
    maxBufferedAmountBytes?: number;
    bufferedAmountLowWaterBytes?: number;
    bufferedAmountPollMs?: number;
  }>;

async function createTestTransport(options: TestTransportOptions) {
  const maxDataPayloadBytes = options.protocol?.maxDataPayloadBytes;
  if (
    options.maxBufferedAmountBytes !== undefined &&
    maxDataPayloadBytes !== undefined &&
    options.maxBufferedAmountBytes <
      maxDataPayloadBytes + BINARY_PROTOCOL.headerBytes
  ) {
    throw new TypeError(
      "maxBufferedAmountBytes must accommodate one maximum-sized binary frame",
    );
  }
  const connection = await createFrameConnection(
    adaptSocketConnection(options.socket),
    {
      negotiatedProtocol: options.negotiatedProtocol,
      signal: options.signal,
      maxInboundFrames: options.maxInboundMessages,
      maxInboundBytes: options.maxInboundBytes,
      maxPendingSendFrames: options.maxPendingSendMessages,
      maxPendingSendBytes: options.maxPendingSendBytes,
      maxBufferedAmountBytes: options.maxBufferedAmountBytes,
      bufferedAmountLowWaterBytes: options.bufferedAmountLowWaterBytes,
      bufferedAmountPollMs: options.bufferedAmountPollMs,
    },
  );
  return await createProtocolTransport({
    connection,
    role: options.role,
    signal: options.signal,
    maxInboundMessages: options.maxInboundMessages,
    maxInboundBytes: options.maxInboundBytes,
    maxPendingSendMessages: options.maxPendingSendMessages,
    maxPendingSendBytes: options.maxPendingSendBytes,
    protocol: options.protocol,
  });
}

function createCallbackWireConnection(): Readonly<{
  connection: SocketConnection;
  sent: readonly (string | Uint8Array)[];
  close(event?: Partial<SocketClose>): void;
}> {
  const observers = new Set<SocketObserver>();
  const sent: (string | Uint8Array)[] = [];
  let state: SocketConnection["state"] = "open";
  const connection: SocketConnection = Object.freeze({
    protocol: WORKER_PROTOCOL,
    get state() {
      return state;
    },
    bufferedAmount: 0,
    send(data) {
      sent.push(data);
    },
    close(code = 1000, reason = "") {
      if (state === "closed") return;
      state = "closed";
      for (const observer of observers) {
        observer.close?.({ code, reason, wasClean: true });
      }
    },
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
  });
  return Object.freeze({
    connection,
    sent,
    close(event = {}) {
      if (state === "closed") return;
      state = "closed";
      for (const observer of observers) {
        observer.close?.({
          code: event.code ?? 1000,
          reason: event.reason ?? "",
          wasClean: event.wasClean ?? true,
        });
      }
    },
  });
}

test("cancelling an unsent control frame preserves the shared transport", async () => {
  const wire = createCallbackWireConnection();
  const transport = await createTestTransport({
    socket: wire.connection,
    role: "worker",
  });
  const abort = new AbortController();
  abort.abort("operation_cancelled");
  try {
    await assert.rejects(
      transport.sendControl(HELLO, { signal: abort.signal }),
      (error: unknown) => error === "operation_cancelled",
    );
    assert.equal(wire.connection.state, "open");
    assert.equal(wire.sent.length, 0);
    await transport.sendControl(HELLO);
    assert.equal(wire.sent.length, 1);
  } finally {
    await transport.close();
  }
});

test("transport accepts a callback-based runtime wire connection", async () => {
  const wire = createCallbackWireConnection();
  const transport = await createTestTransport({
    socket: wire.connection,
    role: "worker",
  });
  await transport.sendControl(HELLO);
  assert.deepStrictEqual(wire.sent.length, 1);
  wire.close({ code: 1000, reason: "peer_complete" });
  assert.deepStrictEqual(await transport.closed, {
    code: 1000,
    reason: "peer_complete",
    wasClean: true,
  });
});

test("transport safely handles synchronous wire open subscription", async () => {
  const observers = new Set<SocketObserver>();
  let state: SocketConnection["state"] = "connecting";
  const connection: SocketConnection = Object.freeze({
    protocol: WORKER_PROTOCOL,
    get state() {
      return state;
    },
    bufferedAmount: 0,
    send() {},
    close(code = 1000, reason = "") {
      if (state === "closed") return;
      state = "closed";
      for (const observer of observers) {
        observer.close?.({ code, reason, wasClean: true });
      }
    },
    subscribe(observer) {
      observers.add(observer);
      if (state === "connecting") {
        state = "open";
        observer.open?.();
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        observers.delete(observer);
      };
    },
  });

  const transport = await createTestTransport({
    socket: connection,
    role: "worker",
  });
  assert.deepStrictEqual(observers.size, 1);
  connection.close(1000, "test_complete");
  await transport.closed;
  assert.deepStrictEqual(observers.size, 0);
});

type FakeSocket = Readonly<{
  socket: WebSocket;
  setBufferedAmount(bytes: number): void;
  dispatchMessageAndClose(
    data: string | ArrayBufferView | ArrayBuffer | Blob,
    close?: Readonly<{ code?: number; reason?: string; wasClean?: boolean }>,
  ): void;
  dispatchError(): void;
  sent(): readonly (string | ArrayBufferView | ArrayBuffer | Blob)[];
}>;

function createFakeSocket(
  options: Readonly<{
    bufferedAmount?: number;
    sendError?: unknown;
  }> = {},
): FakeSocket {
  const target = new EventTarget();
  const sent: (string | ArrayBufferView | ArrayBuffer | Blob)[] = [];
  let readyState: number = WebSocket.OPEN;
  let bufferedAmount = options.bufferedAmount ?? 0;
  const socket = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return bufferedAmount;
    },
    protocol: WORKER_PROTOCOL,
    binaryType: "arraybuffer",
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    send(data: string | ArrayBufferView | ArrayBuffer | Blob): void {
      if (options.sendError !== undefined) throw options.sendError;
      sent.push(data);
    },
    close(code = 1000, reason = ""): void {
      if (readyState === WebSocket.CLOSED) return;
      readyState = WebSocket.CLOSED;
      queueMicrotask(() => {
        target.dispatchEvent(
          new CloseEvent("close", {
            code,
            reason,
            wasClean: true,
          }),
        );
      });
    },
  } as unknown as WebSocket;
  return {
    socket,
    setBufferedAmount: (bytes) => {
      bufferedAmount = bytes;
    },
    dispatchMessageAndClose: (data, close = {}) => {
      if (readyState === WebSocket.CLOSED) return;
      target.dispatchEvent(new MessageEvent("message", { data }));
      readyState = WebSocket.CLOSED;
      target.dispatchEvent(
        new CloseEvent("close", {
          code: close.code ?? 1000,
          reason: close.reason ?? "",
          wasClean: close.wasClean ?? true,
        }),
      );
    },
    dispatchError: () => target.dispatchEvent(new Event("error")),
    sent: () => sent,
  };
}

test("real transport closes an invalid protocol peer with stable 4xxx code", async () => {
  const peer = await startTestPeer();
  let worker: Awaited<ReturnType<typeof createTestTransport>> | undefined;
  try {
    const socket = await connectWorkerWebSocket({
      url: peer.url,
      allowInsecureLoopback: true,
    });
    worker = await createTestTransport({ socket, role: "worker" });
    const hypervisor = await peer.nextConnection();
    await worker.sendControl(HELLO);
    await nextControl(hypervisor, "hello");

    hypervisor.socket.send("{malformed");
    const localClose = await withTimeout(worker.closed);
    const remoteClose = await withTimeout(hypervisor.transport.closed);
    assert.deepStrictEqual(localClose.code, 4400);
    assert.deepStrictEqual(localClose.reason, "invalid_control_frame");
    assert.deepStrictEqual(remoteClose.code, 4400);
    assert.deepStrictEqual(remoteClose.reason, "invalid_control_frame");
  } finally {
    await worker?.close().catch(() => undefined);
    await peer.close();
  }
});

test("worker socket factory can authenticate before Oxian owns Open", async () => {
  const peer = await startTestPeer();
  let factoryCalls = 0;
  let factorySignal: AbortSignal | undefined;
  let socket: WebSocket | undefined;
  try {
    socket = await connectWorkerWebSocket({
      url: peer.url,
      allowInsecureLoopback: true,
      async createWebSocket(context) {
        factoryCalls++;
        factorySignal = context.signal;
        assert.deepStrictEqual(context.url.href, peer.url);
        assert.deepStrictEqual(context.protocol, WORKER_PROTOCOL);
        assert.deepStrictEqual(context.signal.aborted, false);
        await Promise.resolve();
        return new WebSocket(context.url, context.protocol);
      },
    });
    await peer.nextConnection();
    assert.deepStrictEqual(factoryCalls, 1);
    assert.deepStrictEqual(factorySignal?.aborted, false);
    assert.deepStrictEqual(socket.protocol, WORKER_PROTOCOL);
  } finally {
    socket?.close(1000, "test_complete");
    await peer.close();
  }
});

test("worker socket factory authentication is inside the connect deadline", async () => {
  let factorySignal: AbortSignal | undefined;
  await assertRejects(
    () =>
      connectWorkerWebSocket({
        url: "wss://example.test/workers",
        timeoutMs: 20,
        createWebSocket(context) {
          factorySignal = context.signal;
          return new Promise<WebSocket>(() => undefined);
        },
      }),
    DOMException,
    "timed out",
  );
  assert.deepStrictEqual(factorySignal?.aborted, true);
});

test("worker socket URL rejects embedded credentials before invoking its factory", async () => {
  let factoryCalls = 0;
  for (const url of [
    "wss://worker:secret@example.test/workers",
    "wss://example.test/workers?capability=secret",
    "wss://example.test/workers#credential",
  ]) {
    await assertRejects(
      () =>
        connectWorkerWebSocket({
          url,
          createWebSocket() {
            factoryCalls++;
            return createFakeSocket().socket;
          },
        }),
      TypeError,
      "credential-free",
    );
  }
  assert.deepStrictEqual(factoryCalls, 0);
});

test("fatal queue close discards retained values", async () => {
  const queue = createBoundedAsyncQueue<number>({
    maxItems: 2,
    maxWeight: 2,
    weigh: () => 1,
  });
  const failure = new Error("fatal");
  queue.push(1);
  queue.close(failure, { discard: true });
  assert.deepStrictEqual(queue.snapshot(), {
    items: 0,
    weight: 0,
    closed: true,
  });
  await assertRejects(
    () => queue.iterable[Symbol.asyncIterator]().next(),
    Error,
    "fatal",
  );
});

test("send failure poisons advanced protocol state deterministically", async () => {
  const sendFailure = new Error("native send failed");
  const fake = createFakeSocket({ sendError: sendFailure });
  const transport = await createTestTransport({
    socket: fake.socket,
    role: "worker",
  });

  await assertRejects(
    () => transport.sendControl(HELLO),
    Error,
    "native send failed",
  );
  assert.deepStrictEqual(await transport.closed, {
    code: 4500,
    reason: "transport_failed",
    wasClean: false,
  });
  await assertRejects(() => transport.sendControl(HELLO), TypeError, "closed");
});

test("transport drains a received terminal frame before peer close", async () => {
  const fake = createFakeSocket();
  const transport = await createTestTransport({
    socket: fake.socket,
    role: "hypervisor",
  });
  const messages = transport.messages()[Symbol.asyncIterator]();

  fake.dispatchMessageAndClose(encodeControlFrame(HELLO), {
    code: 1000,
    reason: "peer_terminal",
  });

  const first = await messages.next();
  assert.deepStrictEqual(first.done, false);
  assert.deepStrictEqual(first.value?.kind, "control");
  if (first.value?.kind === "control") {
    assert.deepStrictEqual(first.value.acceptance.frame, HELLO);
  }
  assert.deepStrictEqual(await messages.next(), {
    value: undefined,
    done: true,
  });
  assert.deepStrictEqual(await transport.closed, {
    code: 1000,
    reason: "peer_terminal",
    wasClean: true,
  });
});

test("socket error settles closed and a full send queue holds later sends", async () => {
  const abortController = new AbortController();
  const fake = createFakeSocket({ bufferedAmount: 2 * 1024 * 1024 });
  const transport = await createTestTransport({
    socket: fake.socket,
    role: "worker",
    signal: abortController.signal,
    maxPendingSendMessages: 1,
    bufferedAmountPollMs: 1,
  });

  const first = transport.sendControl(HELLO);
  // A full queue makes the next send wait its turn instead of failing.
  let secondSettled = false;
  const second = transport.sendControl(HELLO).finally(() => {
    secondSettled = true;
  });
  void second.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(secondSettled, false);
  assert.deepStrictEqual(fake.sent().length, 0);
  abortController.abort(new DOMException("test abort", "AbortError"));
  await assertRejects(() => first, DOMException);
  await assertRejects(() => second, TypeError, "closed");
  await transport.closed;

  const errored = createFakeSocket();
  const erroredTransport = await createTestTransport({
    socket: errored.socket,
    role: "worker",
  });
  errored.dispatchError();
  assert.deepStrictEqual(await erroredTransport.closed, {
    code: 4500,
    reason: "transport_failed",
    wasClean: false,
  });
});

test("transport enforces admission, buffer relation, and close wire bounds", async () => {
  const fake = createFakeSocket();
  const transport = await createTestTransport({
    socket: fake.socket,
    role: "worker",
    protocol: {
      ...({ role: "hypervisor" } as unknown as { role: "hypervisor" }),
      maxDataPayloadBytes: 64,
    },
    maxBufferedAmountBytes: 128,
    bufferedAmountLowWaterBytes: 16,
  });
  assert.deepStrictEqual(transport.snapshot().role, "worker");
  await assertRejects(
    () => transport.close({ code: 1011 }),
    TypeError,
    "close code",
  );
  await assertRejects(
    () => transport.close({ reason: "ü".repeat(62) }),
    TypeError,
    "123 UTF-8 bytes",
  );
  await transport.close({ code: 1000, reason: "valid" });

  await assertRejects(
    () =>
      createTestTransport({
        socket: createFakeSocket().socket,
        role: "worker",
        protocol: { maxDataPayloadBytes: 64 },
        maxBufferedAmountBytes: 91,
        bufferedAmountLowWaterBytes: 16,
      }),
    TypeError,
    "maximum-sized binary frame",
  );
});

function createPausableWire(pausable: boolean) {
  const observers = new Set<SocketObserver>();
  const sent: (string | Uint8Array)[] = [];
  const calls: string[] = [];
  let state: SocketConnection["state"] = "open";
  const connection: SocketConnection = Object.freeze({
    protocol: WORKER_PROTOCOL,
    get state() {
      return state;
    },
    bufferedAmount: 0,
    send(data) {
      sent.push(data);
    },
    close(code = 1000, reason = "") {
      if (state === "closed") return;
      state = "closed";
      for (const observer of observers) {
        observer.close?.({ code, reason, wasClean: true });
      }
    },
    subscribe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    ...(pausable
      ? {
          pause: () => void calls.push("pause"),
          resume: () => void calls.push("resume"),
        }
      : {}),
  });
  return {
    connection,
    sent,
    calls,
    deliver(data: string) {
      for (const observer of observers) observer.message?.(data);
    },
    get state() {
      return state;
    },
  };
}

test("a full send queue holds later frames and keeps wire order", async () => {
  const wire = createPausableWire(false);
  const connection = await createFrameConnection(wire.connection, {
    negotiatedProtocol: WORKER_PROTOCOL,
    maxPendingSendFrames: 1,
  });
  const frames = Array.from({ length: 50 }, (_, index) => `frame-${index}`);
  await Promise.all(frames.map((frame) => connection.send(frame)));
  assert.deepStrictEqual(wire.sent, frames);
  assert.deepStrictEqual(wire.state, "open");
});

test("a full inbound queue pauses a pausable socket instead of closing", async () => {
  const wire = createPausableWire(true);
  const connection = await createFrameConnection(wire.connection, {
    negotiatedProtocol: WORKER_PROTOCOL,
    maxInboundFrames: 4,
  });
  const frames = Array.from({ length: 6 }, (_, index) => `in-${index}`);
  for (const frame of frames) wire.deliver(frame);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepStrictEqual(wire.calls, ["pause"]);
  assert.deepStrictEqual(wire.state, "open");
  const reader = connection.incoming.getReader();
  const read: unknown[] = [];
  for (let index = 0; index < frames.length; index++) {
    read.push((await reader.read()).value);
  }
  assert.deepStrictEqual(read, frames);
  assert.deepStrictEqual(wire.calls, ["pause", "resume"]);
  reader.releaseLock();
  connection.close();
});

test("a socket that cannot pause still closes past its inbound bound", async () => {
  const wire = createPausableWire(false);
  const connection = await createFrameConnection(wire.connection, {
    negotiatedProtocol: WORKER_PROTOCOL,
    maxInboundFrames: 2,
  });
  for (let index = 0; index < 4; index++) wire.deliver(`in-${index}`);
  assert.deepStrictEqual(
    (await withTimeout(connection.closed)).reason,
    "inbound_overflow",
  );
});
