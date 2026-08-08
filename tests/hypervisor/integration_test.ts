import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { serve } from "../../src/adapters/deno/index.ts";
import type {
  Hypervisor,
  HypervisorConfig,
  HypervisorError,
  HypervisorListener,
} from "../../src/hypervisor/index.ts";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import {
  parseControlFrame,
  type WorkerIdentity,
} from "../../src/protocol/index.ts";
import type { AcceptanceCommit } from "../../src/supervisor/index.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
  fenceForSession,
} from "../../src/supervisor/index.ts";
import { createWorker } from "../../src/worker/index.ts";
import type {
  WebSocketWorkerOptions,
  WebSocketWorkerTransport,
  Worker,
  WorkerBeforeReadyContext,
  WorkerResult,
  WorkerSnapshot,
  WorkerWorkHandler,
} from "../../src/worker/index.ts";

const TEST_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

type TestHarness = Readonly<{
  hypervisor: Hypervisor;
  listener: HypervisorListener;
  worker: Worker;
  workerRun: Promise<WorkerResult>;
  identity: WorkerIdentity;
  close(): Promise<void>;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = TEST_TIMEOUT_MS,
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

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new DOMException(message, "TimeoutError");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function workerUrl(listener: HypervisorListener, path: string): URL {
  const url = new URL(path, listener.url);
  url.protocol = "ws:";
  return url;
}

function observeWebSocketSends(
  socket: WebSocket,
  options: Readonly<{
    observeSend(data: Parameters<WebSocket["send"]>[0]): void;
    observeBufferedAmount?(actual: number): number | undefined;
  }>,
): WebSocket {
  const send = socket.send.bind(socket);
  return new Proxy(socket, {
    get(target, property) {
      if (property === "bufferedAmount") {
        const actual = Reflect.get(target, property, target) as number;
        return options.observeBufferedAmount?.(actual) ?? actual;
      }
      if (property === "send") {
        return (data: Parameters<WebSocket["send"]>[0]): void => {
          send(data);
          options.observeSend(data);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function streamingBody(
  chunks: readonly Uint8Array[],
  onPull?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks);
}

async function startHarness(
  input: Readonly<{
    workloads: Readonly<Record<string, WorkerWorkHandler>>;
    capacity?: number;
    persistAcceptance?(
      commit: AcceptanceCommit,
    ): Promise<void>;
    config?: Partial<HypervisorConfig>;
    onStateChange?(snapshot: WorkerSnapshot): void | Promise<void>;
    beforeReady?(context: WorkerBeforeReadyContext): void | Promise<void>;
    onReenrollmentRequired?(error: unknown): void | Promise<void>;
    createHeartbeatMetadata?: WebSocketWorkerOptions["createHeartbeatMetadata"];
    socket?: WebSocketWorkerTransport["socket"];
    limits?: WebSocketWorkerTransport["limits"];
  }>,
): Promise<TestHarness> {
  const capacity = input.capacity ?? 2;
  const workloadNames = Object.keys(input.workloads);
  const repository = createInMemoryWorkerRepository();
  await repository.define(createWorkerDefinition({
    workerId: "worker-integration",
    providerId: "attached",
    workloads: workloadNames,
    capacity,
  }));
  const identity = (await repository.activate("worker-integration")).attempt
    .identity;
  const authority = createInMemoryRegistrationAuthority();
  const registration = await authority.issueRegistration(identity);
  const hypervisor = createHypervisor({
    admission: { type: "registered", authority, repository },
    persistAcceptance: input.persistAcceptance ??
      (() => Promise.resolve()),
    config: {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 500,
      leaseSweepIntervalMs: 10,
      shutdownTimeoutMs: 500,
      cancellationAckTimeoutMs: 250,
      maxConnectionAgeMs: 60_000,
      proactiveDrainMarginMs: 1_000,
      ...input.config,
    },
  });
  const listener = serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = createWorker({
    transport: {
      type: "websocket",
      url: workerUrl(listener, hypervisor.config.workerPath),
      allowInsecureLoopback: true,
      connectTimeoutMs: 1_000,
      ...(input.socket === undefined ? {} : { socket: input.socket }),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    },
    identity,
    credential: registration.credential,
    credentialPersistence: "ephemeral",
    workloads: input.workloads,
    capacity,
    reconnectDelay: () => 0,
    handshakeTimeoutMs: 1_000,
    onStateChange: input.onStateChange,
    ...(input.createHeartbeatMetadata === undefined
      ? {}
      : { createHeartbeatMetadata: input.createHeartbeatMetadata }),
    ...(input.beforeReady === undefined
      ? {}
      : { beforeReady: input.beforeReady }),
    ...(input.onReenrollmentRequired === undefined
      ? {}
      : { onReenrollmentRequired: input.onReenrollmentRequired }),
  });
  const workerRun = worker.run();

  try {
    await withTimeout(worker.whenReady(), TEST_TIMEOUT_MS, "worker not ready");
    await waitFor(
      () => hypervisor.sessions.get(identity.workerId)?.phase === "ready",
      "Hypervisor did not attach the ready worker session",
    );
  } catch (error) {
    await worker.stop("harness_start_failed").catch(() => undefined);
    await hypervisor.shutdown("harness_start_failed").catch(() => undefined);
    await listener.shutdown().catch(() => undefined);
    await workerRun.catch(() => undefined);
    throw error;
  }

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closed !== undefined) return closed;
    closed = (async () => {
      await hypervisor.shutdown("test_cleanup").catch(() => undefined);
      await worker.stop("test_cleanup").catch(() => undefined);
      await listener.shutdown().catch(() => undefined);
      await withTimeout(workerRun, 2_000).catch(() => undefined);
    })();
    return closed;
  };

  return Object.freeze({
    hypervisor,
    listener,
    worker,
    workerRun,
    identity,
    close,
  });
}

Deno.test({
  name:
    "one Hypervisor schedules in-process and WebSocket Workers through one ledger",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const releaseRemote = createDeferred<void>();
    const harness = await startHarness({
      capacity: 1,
      workloads: {
        shared: async ({ sendMetadata }) => {
          await sendMetadata({ worker: "websocket" });
          await releaseRemote.promise;
        },
      },
    });
    const local = createWorker({
      id: "worker-local",
      capacity: 1,
      transport: { type: "in-process", hypervisor: harness.hypervisor },
      workloads: {
        shared: () => ({ metadata: { worker: "in-process" } }),
      },
    });
    const localRun = local.run();

    try {
      await local.whenReady();
      const remote = await harness.hypervisor.dispatch({
        workload: "shared",
        target: { workerId: harness.identity.workerId },
      });
      await remote.started;

      const automaticallyPlaced = await harness.hypervisor.dispatch({
        workload: "shared",
      });
      assertEquals(await automaticallyPlaced.metadata, {
        worker: "in-process",
      });
      await readAll(automaticallyPlaced.output);
      assertEquals(
        (await automaticallyPlaced.completed).status,
        "completed",
      );
      assertEquals(harness.hypervisor.snapshot().work.committed, 1);

      releaseRemote.resolve();
      assertEquals(await remote.metadata, { worker: "websocket" });
      await readAll(remote.output);
      assertEquals((await remote.completed).status, "completed");
    } finally {
      releaseRemote.resolve();
      await local.stop("test_cleanup");
      await localRun;
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "real worker stream commits before Start and exchanges credited bodies through completion",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const persistEntered = createDeferred<AcceptanceCommit>();
    const releasePersistence = createDeferred<void>();
    const handlerEntered = createDeferred<void>();
    const receivedInput = createDeferred<Uint8Array>();
    const requestChunks = [
      encoder.encode("request:"),
      new Uint8Array(32 * 1_024).fill(0x5a),
      encoder.encode(":complete"),
    ];
    const expectedInput = concat(requestChunks);
    const expectedOutput = concat([
      encoder.encode("response:"),
      expectedInput,
    ]);
    let inputPulls = 0;
    let persistCalls = 0;

    const harness = await startHarness({
      persistAcceptance: async (commit) => {
        persistCalls++;
        persistEntered.resolve(commit);
        await releasePersistence.promise;
      },
      workloads: {
        "sandbox.command": async (context) => {
          handlerEntered.resolve();
          const input = await readAll(context.input);
          receivedInput.resolve(input);
          await context.sendMetadata({
            contentType: "application/octet-stream",
            source: "real-worker",
          });
          return {
            body: streamingBody([
              encoder.encode("response:"),
              input,
            ]),
          };
        },
      },
    });

    try {
      const handle = await withTimeout(harness.hypervisor.dispatch({
        workload: "sandbox.command",
        metadata: { requestId: "integration-request" },
        body: streamingBody(requestChunks, () => inputPulls++),
      }));

      const commit = await withTimeout(
        persistEntered.promise,
        TEST_TIMEOUT_MS,
        "worker did not accept the offered stream",
      );
      assertEquals(commit.operationId, handle.operationId);
      assertEquals(commit.assignment.streamId, handle.streamId);
      assertEquals(persistCalls, 1);
      assertEquals(inputPulls, 0);
      assertEquals(harness.worker.snapshot().activeStreams, 1);

      // Several heartbeats cross the accepted-but-not-started stream while the
      // durable acceptance hook is gated. Advisory inflight metrics must not
      // invalidate the Hypervisor's authoritative reservation.
      await new Promise((resolve) => setTimeout(resolve, 75));
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
        1,
      );
      assertEquals(harness.worker.snapshot().state, "ready");

      releasePersistence.resolve();
      await withTimeout(handle.started);
      await withTimeout(handlerEntered.promise);
      await waitFor(
        () => inputPulls > 0,
        "Hypervisor did not pull request data after worker credit",
      );

      assertEquals(await withTimeout(handle.metadata), {
        contentType: "application/octet-stream",
        source: "real-worker",
      });
      assertEquals(await withTimeout(readAll(handle.output)), expectedOutput);
      assertEquals(await withTimeout(receivedInput.promise), expectedInput);

      const completed = await withTimeout(handle.completed);
      assertEquals(completed.status, "completed");
      assertEquals(completed.operationId, handle.operationId);
      await waitFor(
        () => harness.worker.snapshot().activeStreams === 0,
        "worker did not observe the Hypervisor's terminal work.end",
      );
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
        0,
      );
      assertEquals(
        Object.values(harness.hypervisor.snapshot().work).reduce(
          (total, count) => total + count,
          0,
        ),
        0,
      );
      assertExists(harness.hypervisor.sessions.get(harness.identity.workerId));
    } finally {
      releasePersistence.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "ambiguous acceptance persistence cancels only its stream and preserves multiplexed work",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    let failNextPersistence = true;
    let handlerCalls = 0;
    const harness = await startHarness({
      persistAcceptance: () => {
        if (failNextPersistence) {
          failNextPersistence = false;
          throw new Error("commit acknowledgement was lost");
        }
        return Promise.resolve();
      },
      workloads: {
        "sandbox.command": async (context) => {
          handlerCalls++;
          await context.sendMetadata({ execution: handlerCalls });
          return encoder.encode(`completed:${handlerCalls}`);
        },
      },
    });

    try {
      const connectionId = harness.worker.snapshot().connectionId;
      const ambiguous = await withTimeout(harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }));

      assertEquals(
        (await withTimeout(ambiguous.completed)).status,
        "indeterminate",
      );
      await assertRejects(() => ambiguous.started, Error);
      await assertRejects(() => ambiguous.metadata, Error);
      await assertRejects(() => readAll(ambiguous.output), Error);
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)
            ?.reserved === 0,
        "ambiguous stream did not release its reservation after peer terminal",
      );
      assertEquals(handlerCalls, 0);
      assertEquals(harness.worker.snapshot().state, "ready");
      assertEquals(harness.worker.snapshot().connectionId, connectionId);

      const healthy = await withTimeout(harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }));
      await withTimeout(healthy.started);
      assertEquals(await withTimeout(healthy.metadata), { execution: 1 });
      assertEquals(
        await withTimeout(readAll(healthy.output)),
        encoder.encode("completed:1"),
      );
      assertEquals((await withTimeout(healthy.completed)).status, "completed");
      assertEquals(handlerCalls, 1);
      assertEquals(harness.worker.snapshot().connectionId, connectionId);
      await waitFor(
        () =>
          Object.values(harness.hypervisor.snapshot().work).every(
            (count) => count === 0,
          ),
        "terminal dispatch entries were not evicted",
      );
    } finally {
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "cancellation crossing an in-flight acceptance commit never starts the handler",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const persistEntered = createDeferred<void>();
    const releasePersistence = createDeferred<void>();
    let handlerCalls = 0;
    const harness = await startHarness({
      persistAcceptance: async () => {
        persistEntered.resolve();
        await releasePersistence.promise;
      },
      workloads: {
        "sandbox.command": () => {
          handlerCalls++;
        },
      },
    });

    try {
      const handle = await withTimeout(harness.hypervisor.dispatch({
        workload: "sandbox.command",
        body: encoder.encode("must-not-be-consumed"),
      }));
      await withTimeout(persistEntered.promise);

      const cancellation = handle.cancel("caller_cancelled_before_start");
      releasePersistence.resolve();
      const cancelled = await withTimeout(cancellation);

      assertEquals(cancelled.status, "cancelled");
      await assertRejects(() => handle.started, Error);
      await assertRejects(() => handle.metadata, Error);
      await assertRejects(() => readAll(handle.output), Error);
      assertEquals(handlerCalls, 0);
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)
            ?.reserved === 0,
        "cancelled stream did not release its reservation",
      );
      assertEquals(harness.worker.snapshot().state, "ready");
      assertEquals(
        Object.values(harness.hypervisor.snapshot().work).reduce(
          (total, count) => total + count,
          0,
        ),
        0,
      );
    } finally {
      releasePersistence.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "proactive connection-age drain closes without Shutdown and worker reconnects",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const states: WorkerSnapshot[] = [];
    let workerRunSettled = false;
    const harness = await startHarness({
      workloads: {
        "sandbox.command": () => undefined,
      },
      config: {
        maxConnectionAgeMs: 400,
        proactiveDrainMarginMs: 300,
        shutdownTimeoutMs: 200,
      },
      onStateChange(snapshot) {
        states.push(snapshot);
      },
    });
    harness.workerRun.finally(() => {
      workerRunSettled = true;
    });

    try {
      const firstConnectionId = harness.worker.snapshot().connectionId;
      assertExists(firstConnectionId);
      await waitFor(
        () => {
          const session = harness.hypervisor.sessions.get(
            harness.identity.workerId,
          );
          const worker = harness.worker.snapshot();
          return session?.phase === "ready" &&
            session.connectionId !== firstConnectionId &&
            worker.state === "ready" &&
            worker.connectionId === session.connectionId;
        },
        "worker and Hypervisor did not converge on a ready replacement session",
      );

      assertEquals(workerRunSettled, false);
      assertEquals(harness.worker.snapshot().state, "ready");
      assertEquals(
        states.some((snapshot) => snapshot.state === "draining"),
        true,
      );
      assertEquals(
        states.some((snapshot) => snapshot.state === "drained"),
        true,
      );
      assertEquals(
        states.filter((snapshot) => snapshot.state === "ready").length >= 2,
        true,
      );
      assertEquals(harness.hypervisor.snapshot().connections, 1);
    } finally {
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "public maintenance drain reconnects while terminal worker shutdown ends run without re-enrollment",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const states: WorkerSnapshot[] = [];
    let readyHooks = 0;
    let reenrollmentNotifications = 0;
    let workerRunSettled = false;
    const harness = await startHarness({
      workloads: {
        "sandbox.command": () => undefined,
      },
      beforeReady() {
        readyHooks++;
      },
      onReenrollmentRequired() {
        reenrollmentNotifications++;
      },
      onStateChange(snapshot) {
        states.push(snapshot);
      },
    });
    void harness.workerRun.finally(() => {
      workerRunSettled = true;
    });

    try {
      const firstConnectionId = harness.worker.snapshot().connectionId;
      assertExists(firstConnectionId);

      await withTimeout(
        harness.hypervisor.drain(
          harness.identity.workerId,
          "integration_rotation",
        ),
      );
      await waitFor(
        () => {
          const session = harness.hypervisor.sessions.get(
            harness.identity.workerId,
          );
          return session?.phase === "ready" &&
            session.connectionId !== firstConnectionId;
        },
        "maintenance drain did not reconnect the worker",
      );

      assertEquals(workerRunSettled, false);
      assertEquals(readyHooks, 2);
      assertEquals(reenrollmentNotifications, 0);
      assertEquals(harness.hypervisor.snapshot().acceptingConnections, true);

      // A terminal request must upgrade an already-started maintenance drain;
      // otherwise the peer close would race the intent and reconnect again.
      const finalRotation = harness.hypervisor.drain(
        harness.identity.workerId,
        "racing_final_rotation",
      );
      const terminalShutdown = harness.hypervisor.shutdownWorker(
        harness.identity.workerId,
        "integration_worker_shutdown",
      );
      await withTimeout(Promise.all([finalRotation, terminalShutdown]));
      assertEquals(await withTimeout(harness.workerRun), {
        reason: "shutdown",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      assertEquals(readyHooks, 2);
      assertEquals(reenrollmentNotifications, 0);
      assertEquals(harness.worker.snapshot().state, "stopped");
      assertEquals(harness.hypervisor.snapshot().connections, 0);
      assertEquals(harness.hypervisor.snapshot().sessions, 0);
      assertEquals(harness.hypervisor.snapshot().acceptingConnections, true);
      assertEquals(
        states.filter((snapshot) => snapshot.state === "ready").length,
        2,
      );
    } finally {
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "terminal worker shutdown fences a pending heartbeat until in-flight work completes",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const heartbeatEntered = createDeferred<void>();
    const releaseHeartbeat = createDeferred<void>();
    const heartbeatReturning = createDeferred<void>();
    const drainReceived = createDeferred<void>();
    const drainedSendBlocked = createDeferred<void>();
    const drainedSent = createDeferred<void>();
    const handlerEntered = createDeferred<void>();
    const releaseHandler = createDeferred<void>();
    let shutdownSettled = false;
    let blockSendAfterWorkEnd = false;
    let releaseBlockedSend = false;
    const states: WorkerSnapshot[] = [];
    const harness = await startHarness({
      workloads: {
        "sandbox.command": async () => {
          handlerEntered.resolve();
          await releaseHandler.promise;
          return {
            metadata: { completion: "normal" },
            body: encoder.encode("completed-before-shutdown"),
          };
        },
      },
      createHeartbeatMetadata: async () => {
        heartbeatEntered.resolve();
        await releaseHeartbeat.promise;
        heartbeatReturning.resolve();
        throw new Error("stale heartbeat metadata failed during drain");
      },
      socket(context) {
        const socket = new WebSocket(context.url, context.protocol);
        socket.addEventListener("message", (event) => {
          if (
            typeof event.data === "string" &&
            parseControlFrame(event.data).type === "drain"
          ) {
            drainReceived.resolve();
          }
        });
        return observeWebSocketSends(socket, {
          observeSend(data) {
            if (typeof data !== "string") return;
            const frame = parseControlFrame(data);
            if (frame.type === "work.end") {
              blockSendAfterWorkEnd = true;
            } else if (frame.type === "drained") {
              drainedSent.resolve();
            }
          },
          observeBufferedAmount(actual) {
            if (!blockSendAfterWorkEnd || releaseBlockedSend) return actual;
            drainedSendBlocked.resolve();
            return 3 * 1_024 * 1_024;
          },
        });
      },
      limits: { bufferedAmountPollMs: 1 },
      onStateChange(snapshot) {
        states.push(snapshot);
      },
    });

    try {
      await withTimeout(heartbeatEntered.promise);
      const handle = await withTimeout(harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }));
      await withTimeout(handle.started);
      await withTimeout(handlerEntered.promise);

      const shutdown = harness.hypervisor.shutdownWorker(
        harness.identity.workerId,
        "ordered_terminal_shutdown",
      );
      void shutdown.finally(() => {
        shutdownSettled = true;
      });
      await waitFor(
        () => harness.worker.snapshot().state === "draining",
        "worker did not enter terminal drain",
      );
      await withTimeout(drainReceived.promise);
      assertEquals(shutdownSettled, false);
      assertEquals(harness.worker.snapshot().activeStreams, 1);

      releaseHandler.resolve();
      assertEquals(await withTimeout(handle.metadata), {
        completion: "normal",
      });
      assertEquals(
        await withTimeout(readAll(handle.output)),
        encoder.encode("completed-before-shutdown"),
      );
      assertEquals((await withTimeout(handle.completed)).status, "completed");
      await withTimeout(drainedSendBlocked.promise);
      releaseHeartbeat.resolve();
      await withTimeout(heartbeatReturning.promise);
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseBlockedSend = true;
      await withTimeout(drainedSent.promise);
      await withTimeout(shutdown);

      assertEquals(await withTimeout(harness.workerRun), {
        reason: "shutdown",
      });
      assertEquals(
        states.some((snapshot) => snapshot.state === "drained"),
        true,
      );
      assertEquals(states.at(-1)?.state, "stopped");
      assertEquals(harness.hypervisor.snapshot().acceptingConnections, true);
      assertEquals(harness.hypervisor.snapshot().connections, 0);
      assertEquals(harness.hypervisor.snapshot().sessions, 0);
    } finally {
      releaseHandler.resolve();
      releaseHeartbeat.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name: "exact session shutdown cannot terminate a replacement connection",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const harness = await startHarness({
      workloads: {
        "sandbox.command": () => undefined,
      },
    });
    try {
      const first = harness.hypervisor.sessions.get(harness.identity.workerId);
      assertExists(first);
      const staleFence = fenceForSession(first);

      await withTimeout(
        harness.hypervisor.drain(
          harness.identity.workerId,
          "replace_exact_session",
        ),
      );
      await waitFor(
        () => {
          const current = harness.hypervisor.sessions.get(
            harness.identity.workerId,
          );
          return current?.phase === "ready" &&
            current.connectionId !== staleFence.connectionId;
        },
        "worker did not replace its drained session",
      );

      const replacement = harness.hypervisor.sessions.get(
        harness.identity.workerId,
      );
      assertExists(replacement);
      const replacementFence = fenceForSession(replacement);
      await withTimeout(
        harness.hypervisor.shutdownSession(
          staleFence,
          "stale_attempt_cleanup",
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      assertEquals(harness.worker.snapshot().state, "ready");
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)
          ?.connectionId,
        replacementFence.connectionId,
      );

      await withTimeout(
        harness.hypervisor.shutdownSession(
          replacementFence,
          "current_attempt_cleanup",
        ),
      );
      assertEquals(await withTimeout(harness.workerRun), {
        reason: "shutdown",
      });
    } finally {
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "exact worker dispatch never spills while untargeted work still balances",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const repository = createInMemoryWorkerRepository();
    await repository.define(createWorkerDefinition({
      workerId: "worker-target-a",
      providerId: "attached",
      workloads: ["sandbox.command"],
      capacity: 1,
    }));
    await repository.define(createWorkerDefinition({
      workerId: "worker-target-b",
      providerId: "attached",
      workloads: ["sandbox.command", "sandbox.other"],
      capacity: 1,
    }));
    const identityA = (await repository.activate("worker-target-a")).attempt
      .identity;
    const identityB = (await repository.activate("worker-target-b")).attempt
      .identity;
    const authority = createInMemoryRegistrationAuthority();
    const registrationA = await authority.issueRegistration(identityA);
    const registrationB = await authority.issueRegistration(identityB);
    const hypervisor = createHypervisor({
      admission: { type: "registered", authority, repository },
      persistAcceptance: () => Promise.resolve(),
      config: {
        heartbeatIntervalMs: 20,
        leaseTimeoutMs: 500,
        leaseSweepIntervalMs: 10,
        shutdownTimeoutMs: 500,
        cancellationAckTimeoutMs: 250,
        maxConnectionAgeMs: 60_000,
        proactiveDrainMarginMs: 1_000,
      },
    });
    const listener = serve({
      hypervisor,
      hostname: "127.0.0.1",
      port: 0,
    });
    const workerBEntered = createDeferred<void>();
    const releaseWorkerB = createDeferred<void>();
    const workerA = createWorker({
      transport: {
        type: "websocket",
        url: workerUrl(listener, hypervisor.config.workerPath),
        allowInsecureLoopback: true,
        connectTimeoutMs: 1_000,
      },
      identity: identityA,
      credential: registrationA.credential,
      credentialPersistence: "ephemeral",
      workloads: {
        "sandbox.command": () => ({
          metadata: { handledBy: identityA.workerId },
        }),
      },
      capacity: 1,
      reconnectDelay: () => 0,
      handshakeTimeoutMs: 1_000,
    });
    const workerB = createWorker({
      transport: {
        type: "websocket",
        url: workerUrl(listener, hypervisor.config.workerPath),
        allowInsecureLoopback: true,
        connectTimeoutMs: 1_000,
      },
      identity: identityB,
      credential: registrationB.credential,
      credentialPersistence: "ephemeral",
      workloads: {
        "sandbox.command": async () => {
          workerBEntered.resolve();
          await releaseWorkerB.promise;
          return { metadata: { handledBy: identityB.workerId } };
        },
        "sandbox.other": () => ({
          metadata: { handledBy: identityB.workerId },
        }),
      },
      capacity: 1,
      reconnectDelay: () => 0,
      handshakeTimeoutMs: 1_000,
    });
    const workerARun = workerA.run();
    const workerBRun = workerB.run();

    try {
      await withTimeout(Promise.all([
        workerA.whenReady(),
        workerB.whenReady(),
      ]));
      await waitFor(
        () =>
          hypervisor.sessions.get(identityA.workerId)?.phase === "ready" &&
          hypervisor.sessions.get(identityB.workerId)?.phase === "ready",
        "Hypervisor did not attach both target workers",
      );

      const missing = await assertRejects(() =>
        hypervisor.dispatch({
          workload: "sandbox.command",
          target: { workerId: "worker-target-missing" },
        })
      ) as HypervisorError;
      assertEquals(missing.code, "worker_unavailable");

      const wrongWorkload = await assertRejects(() =>
        hypervisor.dispatch({
          workload: "sandbox.other",
          target: { workerId: identityA.workerId },
        })
      ) as HypervisorError;
      assertEquals(wrongWorkload.code, "worker_unavailable");

      const targeted = await withTimeout(hypervisor.dispatch({
        workload: "sandbox.command",
        target: { workerId: identityB.workerId },
      }));
      await withTimeout(targeted.started);
      await withTimeout(workerBEntered.promise);
      assertEquals(
        hypervisor.sessions.get(identityB.workerId)?.reserved,
        1,
      );
      assertEquals(
        hypervisor.sessions.get(identityA.workerId)?.reserved,
        0,
      );

      const atCapacity = await assertRejects(() =>
        hypervisor.dispatch({
          workload: "sandbox.command",
          target: { workerId: identityB.workerId },
        })
      ) as HypervisorError;
      assertEquals(atCapacity.code, "worker_unavailable");
      assertEquals(
        hypervisor.sessions.get(identityA.workerId)?.reserved,
        0,
      );

      const balanced = await withTimeout(hypervisor.dispatch({
        workload: "sandbox.command",
      }));
      assertEquals(await withTimeout(balanced.metadata), {
        handledBy: identityA.workerId,
      });
      assertEquals((await withTimeout(balanced.completed)).status, "completed");

      releaseWorkerB.resolve();
      assertEquals(await withTimeout(targeted.metadata), {
        handledBy: identityB.workerId,
      });
      assertEquals((await withTimeout(targeted.completed)).status, "completed");
    } finally {
      releaseWorkerB.resolve();
      await hypervisor.shutdown("test_cleanup").catch(() => undefined);
      await workerA.stop("test_cleanup").catch(() => undefined);
      await workerB.stop("test_cleanup").catch(() => undefined);
      await listener.shutdown().catch(() => undefined);
      await withTimeout(workerARun, 2_000).catch(() => undefined);
      await withTimeout(workerBRun, 2_000).catch(() => undefined);
    }
  },
});

Deno.test({
  name:
    "terminal Hypervisor shutdown drains, sends Shutdown, and stops the worker",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const states: WorkerSnapshot[] = [];
    const harness = await startHarness({
      workloads: {
        "sandbox.command": () => undefined,
      },
      onStateChange(snapshot) {
        states.push(snapshot);
      },
    });

    await withTimeout(harness.hypervisor.shutdown("integration_shutdown"));
    assertEquals(await withTimeout(harness.workerRun), { reason: "shutdown" });
    assertEquals(
      states.some((snapshot) => snapshot.state === "draining"),
      true,
    );
    assertEquals(
      states.some((snapshot) => snapshot.state === "drained"),
      true,
    );
    assertEquals(states.at(-1)?.state, "stopped");
    assertEquals(harness.hypervisor.snapshot().connections, 0);
    assertEquals(harness.hypervisor.snapshot().sessions, 0);
    assertEquals(harness.hypervisor.snapshot().acceptingConnections, false);
    await harness.close();
  },
});
