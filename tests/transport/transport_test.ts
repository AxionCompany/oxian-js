import { assertEquals, assertRejects } from "@std/assert";
import {
  createHelloFrame,
  encodeControlFrame,
  WORKER_PROTOCOL,
} from "../../src/protocol/index.ts";
import { createBoundedAsyncQueue } from "../../src/transport/queue.ts";
import {
  connectWorkerWebSocket,
  createWebSocketTransport,
  type WorkerWireClose,
  type WorkerWireConnection,
  type WorkerWireObserver,
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

function createCallbackWireConnection(): Readonly<{
  connection: WorkerWireConnection;
  sent: readonly (string | Uint8Array)[];
  close(event?: Partial<WorkerWireClose>): void;
}> {
  const observers = new Set<WorkerWireObserver>();
  const sent: (string | Uint8Array)[] = [];
  let state: WorkerWireConnection["state"] = "open";
  const connection: WorkerWireConnection = Object.freeze({
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

Deno.test("transport accepts a callback-based runtime wire connection", async () => {
  const wire = createCallbackWireConnection();
  const transport = await createWebSocketTransport({
    socket: wire.connection,
    role: "worker",
  });
  await transport.sendControl(HELLO);
  assertEquals(wire.sent.length, 1);
  wire.close({ code: 1000, reason: "peer_complete" });
  assertEquals(await transport.closed, {
    code: 1000,
    reason: "peer_complete",
    wasClean: true,
  });
});

Deno.test("transport safely handles synchronous wire open subscription", async () => {
  const observers = new Set<WorkerWireObserver>();
  let state: WorkerWireConnection["state"] = "connecting";
  const connection: WorkerWireConnection = Object.freeze({
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

  const transport = await createWebSocketTransport({
    socket: connection,
    role: "worker",
  });
  assertEquals(observers.size, 1);
  connection.close(1000, "test_complete");
  await transport.closed;
  assertEquals(observers.size, 0);
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
  let readyState = WebSocket.OPEN;
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

Deno.test("real transport closes an invalid protocol peer with stable 4xxx code", async () => {
  const peer = await startTestPeer();
  let worker:
    | Awaited<ReturnType<typeof createWebSocketTransport>>
    | undefined;
  try {
    const socket = await connectWorkerWebSocket({
      url: peer.url,
      allowInsecureLoopback: true,
    });
    worker = await createWebSocketTransport({ socket, role: "worker" });
    const hypervisor = await peer.nextConnection();
    await worker.sendControl(HELLO);
    await nextControl(hypervisor, "hello");

    hypervisor.socket.send("{malformed");
    const localClose = await withTimeout(worker.closed);
    const remoteClose = await withTimeout(hypervisor.transport.closed);
    assertEquals(localClose.code, 4400);
    assertEquals(localClose.reason, "invalid_control_frame");
    assertEquals(remoteClose.code, 4400);
    assertEquals(remoteClose.reason, "invalid_control_frame");
  } finally {
    await worker?.close().catch(() => undefined);
    await peer.close();
  }
});

Deno.test("worker socket factory can authenticate before Oxian owns Open", async () => {
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
        assertEquals(context.url.href, peer.url);
        assertEquals(context.protocol, WORKER_PROTOCOL);
        assertEquals(context.signal.aborted, false);
        await Promise.resolve();
        return new WebSocket(context.url, context.protocol);
      },
    });
    await peer.nextConnection();
    assertEquals(factoryCalls, 1);
    assertEquals(factorySignal?.aborted, false);
    assertEquals(socket.protocol, WORKER_PROTOCOL);
  } finally {
    socket?.close(1000, "test_complete");
    await peer.close();
  }
});

Deno.test("worker socket factory authentication is inside the connect deadline", async () => {
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
  assertEquals(factorySignal?.aborted, true);
});

Deno.test("worker socket URL rejects embedded credentials before invoking its factory", async () => {
  let factoryCalls = 0;
  for (
    const url of [
      "wss://worker:secret@example.test/workers",
      "wss://example.test/workers?capability=secret",
      "wss://example.test/workers#credential",
    ]
  ) {
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
  assertEquals(factoryCalls, 0);
});

Deno.test("fatal queue close discards retained values", async () => {
  const queue = createBoundedAsyncQueue<number>({
    maxItems: 2,
    maxWeight: 2,
    weigh: () => 1,
  });
  const failure = new Error("fatal");
  queue.push(1);
  queue.close(failure, { discard: true });
  assertEquals(queue.snapshot(), { items: 0, weight: 0, closed: true });
  await assertRejects(
    () => queue.iterable[Symbol.asyncIterator]().next(),
    Error,
    "fatal",
  );
});

Deno.test("send failure poisons advanced protocol state deterministically", async () => {
  const sendFailure = new Error("native send failed");
  const fake = createFakeSocket({ sendError: sendFailure });
  const transport = await createWebSocketTransport({
    socket: fake.socket,
    role: "worker",
  });

  await assertRejects(
    () => transport.sendControl(HELLO),
    Error,
    "native send failed",
  );
  assertEquals(await transport.closed, {
    code: 4500,
    reason: "transport_failed",
    wasClean: false,
  });
  await assertRejects(
    () => transport.sendControl(HELLO),
    TypeError,
    "closed",
  );
});

Deno.test("transport drains a received terminal frame before peer close", async () => {
  const fake = createFakeSocket();
  const transport = await createWebSocketTransport({
    socket: fake.socket,
    role: "hypervisor",
  });
  const messages = transport.messages()[Symbol.asyncIterator]();

  fake.dispatchMessageAndClose(encodeControlFrame(HELLO), {
    code: 1000,
    reason: "peer_terminal",
  });

  const first = await messages.next();
  assertEquals(first.done, false);
  assertEquals(first.value?.kind, "control");
  if (first.value?.kind === "control") {
    assertEquals(first.value.acceptance.frame, HELLO);
  }
  assertEquals(await messages.next(), { value: undefined, done: true });
  assertEquals(await transport.closed, {
    code: 1000,
    reason: "peer_terminal",
    wasClean: true,
  });
});

Deno.test("socket error settles closed and pending sends are bounded", async () => {
  const abortController = new AbortController();
  const fake = createFakeSocket({ bufferedAmount: 2 * 1024 * 1024 });
  const transport = await createWebSocketTransport({
    socket: fake.socket,
    role: "worker",
    signal: abortController.signal,
    maxPendingSendMessages: 1,
    bufferedAmountPollMs: 1,
  });

  const first = transport.sendControl(HELLO);
  await assertRejects(
    () => transport.sendControl(HELLO),
    RangeError,
    "send queue",
  );
  assertEquals(fake.sent().length, 0);
  abortController.abort(new DOMException("test abort", "AbortError"));
  await assertRejects(() => first, DOMException);
  await transport.closed;

  const errored = createFakeSocket();
  const erroredTransport = await createWebSocketTransport({
    socket: errored.socket,
    role: "worker",
  });
  errored.dispatchError();
  assertEquals(await erroredTransport.closed, {
    code: 4500,
    reason: "transport_failed",
    wasClean: false,
  });
});

Deno.test("transport enforces admission, buffer relation, and close wire bounds", async () => {
  const fake = createFakeSocket();
  const transport = await createWebSocketTransport({
    socket: fake.socket,
    role: "worker",
    protocol: {
      ...({ role: "hypervisor" } as unknown as { role: "hypervisor" }),
      maxDataPayloadBytes: 64,
    },
    maxBufferedAmountBytes: 128,
    bufferedAmountLowWaterBytes: 16,
  });
  assertEquals(transport.snapshot().role, "worker");
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
      createWebSocketTransport({
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
