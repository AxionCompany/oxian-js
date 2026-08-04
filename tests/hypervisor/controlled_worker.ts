import {
  type ControlFrame,
  createHelloFrame,
  createReadyFrame,
  type JsonObject,
  type WelcomeFrame,
  type WorkerCredential,
  type WorkerIdentity,
} from "../../src/protocol/index.ts";
import {
  connectWorkerWebSocket,
  createWebSocketTransport,
  type WebSocketTransport,
  type WebSocketTransportMessage,
} from "../../src/transport/index.ts";

export type ControlledWorker = Readonly<{
  socket: WebSocket;
  transport: WebSocketTransport;
  iterator: AsyncIterator<WebSocketTransportMessage>;
  welcome: WelcomeFrame;
  close(reason?: string): Promise<void>;
}>;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
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

export async function nextControlledMessage(
  worker: Pick<ControlledWorker, "iterator">,
  timeoutMs = 2_000,
): Promise<WebSocketTransportMessage> {
  const next = await withTimeout(
    worker.iterator.next(),
    timeoutMs,
    "controlled worker did not receive a protocol message",
  );
  if (next.done) {
    throw new TypeError("controlled worker connection ended unexpectedly");
  }
  return next.value;
}

export async function nextControlledControl<
  T extends ControlFrame["type"],
>(
  worker: Pick<ControlledWorker, "iterator">,
  type: T,
  timeoutMs = 2_000,
): Promise<Extract<ControlFrame, { type: T }>> {
  const message = await nextControlledMessage(worker, timeoutMs);
  if (message.kind !== "control") {
    throw new TypeError(
      `expected ${type}, received binary ${message.acceptance.frame.type}`,
    );
  }
  const frame = message.acceptance.frame;
  if (frame.type !== type) {
    throw new TypeError(`expected ${type}, received ${frame.type}`);
  }
  return frame as Extract<ControlFrame, { type: T }>;
}

/**
 * Only call this as the last read before closing the worker. The timed-out
 * iterator read remains pending until closure, preserving the transport's
 * single-consumer invariant.
 */
export async function expectNoControlledMessage(
  worker: Pick<ControlledWorker, "iterator">,
  durationMs = 50,
): Promise<void> {
  const sentinel = Symbol("no-message");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    worker.iterator.next(),
    new Promise<typeof sentinel>((resolve) => {
      timer = setTimeout(() => resolve(sentinel), durationMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (result !== sentinel) {
    if (result.done) return;
    const frame = result.value.acceptance.frame;
    throw new TypeError(`unexpected controlled-worker frame ${frame.type}`);
  }
}

export async function connectControlledWorker(
  input: Readonly<{
    url: string | URL;
    identity: WorkerIdentity;
    credential: WorkerCredential;
    handshakeId: string;
    workloads: readonly string[];
    capacity: number;
    readyMetadata?: JsonObject;
    timeoutMs?: number;
  }>,
): Promise<ControlledWorker> {
  const timeoutMs = input.timeoutMs ?? 2_000;
  const socket = await connectWorkerWebSocket({
    url: input.url,
    allowInsecureLoopback: true,
    timeoutMs,
  });
  const transport = await createWebSocketTransport({
    socket,
    role: "worker",
  });
  const iterator = transport.messages()[Symbol.asyncIterator]();
  const partial = { iterator };

  try {
    await transport.sendControl(createHelloFrame({
      handshakeId: input.handshakeId,
      identity: input.identity,
      credential: input.credential,
      workloads: input.workloads,
      capacity: input.capacity,
    }));
    const welcome = await nextControlledControl(
      partial,
      "welcome",
      timeoutMs,
    );
    await transport.sendControl(createReadyFrame({
      connectionId: welcome.connectionId,
      capacity: input.capacity,
      metadata: input.readyMetadata ?? {},
    }));
    await nextControlledControl(partial, "ready_ack", timeoutMs);

    let closed = false;
    const close = async (reason = "controlled_worker_closed") => {
      if (closed) return;
      closed = true;
      await transport.close({
        code: 4100,
        reason,
        timeoutMs: 250,
      }).catch(() => undefined);
    };
    return Object.freeze({
      socket,
      transport,
      iterator,
      welcome,
      close,
    });
  } catch (error) {
    await transport.close({
      code: 4100,
      reason: "controlled_worker_setup_failed",
      timeoutMs: 250,
    }).catch(() => undefined);
    throw error;
  }
}
