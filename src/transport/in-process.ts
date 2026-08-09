import { WORKER_PROTOCOL } from "../protocol/index.ts";
import type { WorkerActivate, WorkerRegister } from "../lifecycle/index.ts";
import type {
  SocketClose,
  SocketConnection,
  SocketConnectionState,
  SocketObserver,
} from "./types.ts";

const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 1_024;

export type InProcessFabricFrame = string | Uint8Array;

export type InProcessFabricDirection =
  | "hypervisor-to-worker"
  | "worker-to-hypervisor";

/**
 * The physical event published through an in-process fabric.
 *
 * `connectionId` addresses one physical connection. It deliberately differs
 * from the fenced protocol connection ID assigned by Welcome.
 */
export type InProcessFabricEvent = Readonly<{
  topic: string;
  connectionId: string;
  direction: InProcessFabricDirection;
  frame: InProcessFabricFrame;
}>;

/** @internal Deterministic transport-fault seam used by conformance tests. */
export type InProcessFabricInterceptor = (
  event: InProcessFabricEvent,
) => "deliver" | "drop" | void;

export type InProcessFabricProvisioning = Readonly<{
  activate: WorkerActivate;
  register: WorkerRegister;
}>;

export type InProcessTransportBinding = Readonly<{
  topic: string;
  close(reason?: string): void;
}>;

type FabricHost = Readonly<{
  accept(connection: SocketConnection): void;
  provisioning?: InProcessFabricProvisioning;
  intercept?: InProcessFabricInterceptor;
  connections: Set<Readonly<{ close(reason?: string): void }>>;
}>;

type FabricQueue = Readonly<{
  readable: ReadableStream<InProcessFabricEvent>;
  publish(event: InProcessFabricEvent): void;
  close(error?: unknown): void;
  bufferedBytes(): number;
}>;

const fabrics = new Map<string, FabricHost>();
const encoder = new TextEncoder();

function expectTopic(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 512
  ) {
    throw new TypeError(
      "in-process transport config.topic must be a non-empty bounded string without surrounding whitespace",
    );
  }
  return value;
}

function frameBytes(frame: InProcessFabricFrame): number {
  return typeof frame === "string"
    ? encoder.encode(frame).byteLength
    : frame.byteLength;
}

function createFabricQueue(
  limits: Readonly<{
    maxQueuedBytes: number;
    maxQueuedFrames: number;
  }>,
): FabricQueue {
  const events: InProcessFabricEvent[] = [];
  let controller:
    | ReadableStreamDefaultController<InProcessFabricEvent>
    | undefined;
  let bytes = 0;
  let controllerBytes = 0;
  let closed = false;

  const flush = (): void => {
    while (
      !closed &&
      controller !== undefined &&
      events.length > 0 &&
      (controller.desiredSize ?? 0) > 0
    ) {
      const event = events.shift()!;
      const weight = frameBytes(event.frame);
      bytes -= weight;
      controller.enqueue(event);
      if ((controller.desiredSize ?? 0) <= 0) controllerBytes = weight;
    }
  };

  const readable = new ReadableStream<InProcessFabricEvent>({
    start(value) {
      controller = value;
      flush();
    },
    pull() {
      controllerBytes = 0;
      flush();
    },
    cancel() {
      closed = true;
      events.length = 0;
      bytes = 0;
      controllerBytes = 0;
      controller = undefined;
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 }));

  const publish = (event: InProcessFabricEvent): void => {
    if (closed) throw new TypeError("in-process event fabric is closed");
    const weight = frameBytes(event.frame);
    if (weight < 1) {
      throw new TypeError("in-process event-fabric frames must not be empty");
    }
    if (
      events.length + (controllerBytes > 0 ? 1 : 0) >=
        limits.maxQueuedFrames ||
      weight > limits.maxQueuedBytes - bytes - controllerBytes
    ) {
      throw new RangeError("in-process event-fabric queue exceeded its bound");
    }
    events.push(event);
    bytes += weight;
    flush();
  };

  const close = (error?: unknown): void => {
    if (closed) return;
    closed = true;
    events.length = 0;
    bytes = 0;
    controllerBytes = 0;
    if (controller !== undefined) {
      try {
        if (error === undefined) controller.close();
        else controller.error(error);
      } catch {
        // A reader may already have cancelled the stream.
      }
    }
    controller = undefined;
  };

  return Object.freeze({
    readable,
    publish,
    close,
    bufferedBytes: () => bytes + controllerBytes,
  });
}

function createConnectionPair(
  topic: string,
  connectionId: string,
  limits: Readonly<{
    maxQueuedBytes: number;
    maxQueuedFrames: number;
  }>,
  intercept: InProcessFabricInterceptor | undefined,
  remove: () => void,
): Readonly<{
  hypervisor: SocketConnection;
  worker: SocketConnection;
  close(reason?: string): void;
}> {
  const hypervisorQueue = createFabricQueue(limits);
  const workerQueue = createFabricQueue(limits);
  const hypervisorObservers = new Set<SocketObserver>();
  const workerObservers = new Set<SocketObserver>();
  let state: SocketConnectionState = "open";
  let closeValue: SocketClose | undefined;

  const close = (reason = "in_process_connection_closed"): void => {
    if (state === "closed" || state === "closing") return;
    state = "closing";
    const event = Object.freeze({ code: 1000, reason, wasClean: true });
    closeValue = event;
    hypervisorQueue.close();
    workerQueue.close();
    state = "closed";
    remove();
    for (const observer of hypervisorObservers) observer.close?.(event);
    for (const observer of workerObservers) observer.close?.(event);
    hypervisorObservers.clear();
    workerObservers.clear();
  };

  const endpoint = (
    side: "hypervisor" | "worker",
  ): SocketConnection => {
    const incoming = side === "hypervisor" ? hypervisorQueue : workerQueue;
    const outgoing = side === "hypervisor" ? workerQueue : hypervisorQueue;
    const observers = side === "hypervisor"
      ? hypervisorObservers
      : workerObservers;
    const direction: InProcessFabricDirection = side === "hypervisor"
      ? "hypervisor-to-worker"
      : "worker-to-hypervisor";
    let pumping = false;

    const pump = (): void => {
      if (pumping) return;
      pumping = true;
      const reader = incoming.readable.getReader();
      void (async () => {
        try {
          while (state === "open") {
            const next = await reader.read();
            if (next.done) break;
            for (const observer of observers) {
              observer.message?.(next.value.frame);
            }
          }
        } catch (error) {
          for (const observer of observers) observer.error?.(error);
          close("in_process_transport_failed");
        } finally {
          reader.releaseLock();
        }
      })();
    };

    const connection: SocketConnection = {
      get protocol() {
        return WORKER_PROTOCOL;
      },
      get state() {
        return state;
      },
      get bufferedAmount() {
        return outgoing.bufferedBytes();
      },
      send(frame) {
        if (state !== "open") {
          throw new TypeError("in-process connection is closed");
        }
        const event = Object.freeze({
          topic,
          connectionId,
          direction,
          frame,
        });
        if (intercept?.(event) === "drop") return;
        outgoing.publish(event);
      },
      close(_code, reason) {
        close(reason);
      },
      subscribe(observer) {
        if (observer === null || typeof observer !== "object") {
          throw new TypeError("wire observer must be an object");
        }
        if (state === "closed") {
          queueMicrotask(() => observer.close?.(closeValue!));
          return () => undefined;
        }
        observers.add(observer);
        pump();
        queueMicrotask(() => observer.open?.());
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          observers.delete(observer);
        };
      },
    };
    return Object.freeze(connection);
  };

  return Object.freeze({
    hypervisor: endpoint("hypervisor"),
    worker: endpoint("worker"),
    close,
  });
}

/** Internal activation of one Hypervisor-owned event-fabric transport. */
export function bindInProcessFabric(
  input: Readonly<{
    topic: string;
    accept(connection: SocketConnection): void;
    provisioning?: InProcessFabricProvisioning;
    /** @internal Conformance-only observation and deterministic fault seam. */
    intercept?: InProcessFabricInterceptor;
  }>,
): InProcessTransportBinding {
  const topic = expectTopic(input.topic);
  if (typeof input.accept !== "function") {
    throw new TypeError("in-process transport accept must be a function");
  }
  if (fabrics.has(topic)) {
    throw new TypeError(
      `in-process transport topic ${JSON.stringify(topic)} is already bound`,
    );
  }
  const connections = new Set<Readonly<{ close(reason?: string): void }>>();
  const host: FabricHost = Object.freeze({
    accept: input.accept,
    ...(input.provisioning === undefined
      ? {}
      : { provisioning: input.provisioning }),
    ...(input.intercept === undefined ? {} : { intercept: input.intercept }),
    connections,
  });
  fabrics.set(topic, host);
  let active = true;
  return Object.freeze({
    topic,
    close(reason = "in_process_transport_unbound") {
      if (!active) return;
      active = false;
      if (fabrics.get(topic) === host) fabrics.delete(topic);
      for (const connection of [...connections]) connection.close(reason);
      connections.clear();
    },
  });
}

/** Internal Worker-side connection to an explicitly named local fabric. */
export function connectInProcessFabric(
  input: Readonly<{
    topic: string;
    maxQueuedBytes?: number;
    maxQueuedFrames?: number;
  }>,
): SocketConnection {
  const topic = expectTopic(input.topic);
  const host = fabrics.get(topic);
  if (host === undefined) {
    throw new TypeError(
      `no in-process Hypervisor transport is bound to topic ${
        JSON.stringify(topic)
      }`,
    );
  }
  const maxQueuedBytes = input.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
  const maxQueuedFrames = input.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1) {
    throw new TypeError("maxQueuedBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
    throw new TypeError("maxQueuedFrames must be a positive safe integer");
  }
  const connectionId = crypto.randomUUID();
  const pair = createConnectionPair(
    topic,
    connectionId,
    { maxQueuedBytes, maxQueuedFrames },
    host.intercept,
    () => {
      host.connections.delete(pair);
    },
  );
  host.connections.add(pair);
  try {
    host.accept(pair.hypervisor);
  } catch (error) {
    pair.close("in_process_admission_failed");
    throw error;
  }
  return pair.worker;
}

/** Internal access to the host-owned ephemeral provisioning seam. */
export function inProcessFabricProvisioning(
  topicInput: string,
): InProcessFabricProvisioning | undefined {
  const topic = expectTopic(topicInput);
  return fabrics.get(topic)?.provisioning;
}
