import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  createHypervisor as createPublicHypervisor,
  type Hypervisor,
  type HypervisorConfig,
  type HypervisorScheduler,
} from "../../src/hypervisor/index.ts";
import type { AcceptanceCommit } from "../../src/supervisor/index.ts";
import {
  createWorker as createPublicWorker,
  type Worker,
  type WorkerBeforeReadyContext,
  type WorkerSnapshot,
  type WorkerWorkHandler,
} from "../../src/worker/index.ts";
import type { InProcessTransport } from "../../src/transport/index.ts";

const transports = new WeakMap<Hypervisor, InProcessTransport>();

function createHypervisor(
  options: Readonly<{
    commitAcceptedWork(commit: AcceptanceCommit): Promise<void>;
    config?: Partial<HypervisorConfig>;
    clock?: () => number;
    scheduler?: HypervisorScheduler;
  }>,
): Hypervisor {
  const transport = Object.freeze({
    type: "in-process" as const,
    config: Object.freeze({ topic: `in-process-test-${crypto.randomUUID()}` }),
  });
  const hypervisor = createPublicHypervisor({
    transports: [transport],
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  }, {
    onWorkAccepted: async (context) => {
      await options.commitAcceptedWork(Object.freeze({
        operationId: context.operationId,
        workload: context.workload,
        ...(context.target === undefined ? {} : { target: context.target }),
        metadata: context.metadata,
        ...(context.deadlineAtMs === undefined
          ? {}
          : { deadlineAtMs: context.deadlineAtMs }),
        deliveryCount: context.deliveryCount,
        assignment: context.assignment,
        claimedAtMs: context.acceptedAtMs,
      }));
    },
  });
  transports.set(hypervisor, transport);
  return hypervisor;
}

function createWorker(
  options: Readonly<{
    id: string;
    transport: InProcessTransport;
    workloads: Readonly<Record<string, WorkerWorkHandler>>;
    capacity?: number;
    signal?: AbortSignal;
    beforeReady?: (
      context: WorkerBeforeReadyContext,
    ) => void | Promise<void>;
    onStateChange?: (snapshot: WorkerSnapshot) => void | Promise<void>;
  }>,
): Worker {
  const worker = createPublicWorker({
    id: options.id,
    transport: options.transport,
    workloads: options.workloads,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.beforeReady === undefined ? {} : {
      handshake: (context) =>
        options.beforeReady!({
          bootstrap: context.bootstrap,
          connectionId: context.connectionId,
          signal: context.signal,
          reconnecting: context.reconnecting,
        }),
    }),
  });
  if (options.onStateChange !== undefined) {
    const reader = worker.events.getReader();
    void (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          if (next.value.type !== "state") continue;
          try {
            await options.onStateChange?.(next.value.snapshot);
          } catch {
            // Characterization observers never own Worker progress.
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  return worker;
}

function transportFor(hypervisor: Hypervisor): InProcessTransport {
  const transport = transports.get(hypervisor);
  if (transport === undefined) throw new TypeError("unknown test Hypervisor");
  return transport;
}

async function connectLocal(
  hypervisor: Hypervisor,
  input: Readonly<{
    workerId: string;
    workloads: Readonly<Record<string, WorkerWorkHandler>>;
    capacity?: number;
  }>,
): Promise<Worker> {
  const worker = createWorker({
    id: input.workerId,
    workloads: input.workloads,
    capacity: input.capacity,
    transport: transportFor(hypervisor),
  });
  void worker.closed;
  await worker.ready;
  return worker;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

Deno.test("in-process work starts only after durable acceptance commits", async () => {
  const persistence = createDeferred<void>();
  let accepted: AcceptanceCommit | undefined;
  let invoked = false;
  const hypervisor = createHypervisor({
    commitAcceptedWork(commit) {
      accepted = commit;
      return persistence.promise;
    },
  });
  const worker = await connectLocal(hypervisor, {
    workerId: "embedded-worker",
    workloads: {
      "copilotz.turn": () => {
        invoked = true;
        return {
          metadata: { channel: "text" },
          body: new TextEncoder().encode("done"),
        };
      },
    },
  });

  try {
    const deadlineAtMs = Date.now() + 30_000;
    const pendingHandle = hypervisor.dispatch({
      workload: "copilotz.turn",
      target: { workerId: "embedded-worker" },
      metadata: { conversationId: "conversation-1" },
      deadlineAtMs,
    });
    await waitUntil(() => accepted !== undefined);

    assertEquals(invoked, false);
    assertEquals(accepted?.metadata, {
      conversationId: "conversation-1",
    });
    assertEquals(typeof accepted?.operationId, "string");
    assertEquals(accepted?.target, { workerId: "embedded-worker" });
    assertEquals(accepted?.deadlineAtMs, deadlineAtMs);
    assertEquals(accepted?.deliveryCount, 1);
    assertEquals(
      Number.isSafeInteger(accepted?.claimedAtMs) &&
        (accepted?.claimedAtMs ?? -1) >= 0,
      true,
    );
    assertEquals(
      accepted?.assignment.fence.identity,
      worker.snapshot().identity,
    );

    persistence.resolve();
    const handle = await pendingHandle;
    await handle.started;
    assertEquals(invoked, true);
    assertEquals(await handle.metadata, { channel: "text" });
    assertEquals(await readText(handle.output), "done");
    assertEquals((await handle.completed).status, "completed");
    assertEquals(hypervisor.sessions.get("embedded-worker")?.reserved, 0);
  } finally {
    await hypervisor.shutdown();
  }
});

Deno.test("in-process workers are not routable before initialization completes", async () => {
  const initialized = createDeferred<void>();
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const worker = createWorker({
    id: "initializing-worker",
    transport: transportFor(hypervisor),
    workloads: { task: () => undefined },
    beforeReady: () => initialized.promise,
  });
  const running = worker.closed;
  assertStrictEquals(worker.closed, running);

  try {
    await Promise.resolve();
    assertEquals(hypervisor.sessions.get("initializing-worker"), undefined);
    await assertRejects(() => hypervisor.dispatch({ workload: "task" }));

    initialized.resolve();
    await worker.ready;
    assertEquals(
      hypervisor.sessions.get("initializing-worker")?.phase,
      "ready",
    );
    const handle = await hypervisor.dispatch({ workload: "task" });
    await readText(handle.output);
    assertEquals((await handle.completed).status, "completed");
  } finally {
    initialized.resolve();
    await worker.stop("test_complete");
    await running;
    await hypervisor.shutdown();
  }
});

Deno.test("stopping an in-process Worker does not wait for a hung initializer", async () => {
  const entered = createDeferred<void>();
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const worker = createWorker({
    id: "hung-initializer",
    transport: transportFor(hypervisor),
    workloads: { task: () => undefined },
    beforeReady: () => {
      entered.resolve();
      return new Promise<void>(() => undefined);
    },
    onStateChange: () => {
      throw new Error("observer failure");
    },
  });
  const running = worker.closed;

  await entered.promise;
  await worker.stop("test_stop");
  assertEquals(await running, { reason: "stopped" });
  assertEquals(hypervisor.sessions.get("hung-initializer"), undefined);
  await hypervisor.shutdown();
});

Deno.test("maintenance drain cannot expose or duplicate a pre-ready Worker", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  let calls = 0;
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const worker = createWorker({
    id: "serialized-initializer",
    transport: transportFor(hypervisor),
    workloads: { task: () => undefined },
    beforeReady: () => {
      calls++;
      entered.resolve();
      return release.promise;
    },
  });
  const running = worker.closed;

  try {
    await entered.promise;
    await hypervisor.drain("serialized-initializer");
    assertEquals(worker.snapshot().state, "handshaking");
    assertEquals(hypervisor.sessions.get("serialized-initializer"), undefined);
    assertEquals(calls, 1);

    await worker.stop("test_complete");
    assertEquals(await running, { reason: "stopped" });
  } finally {
    release.resolve();
    await hypervisor.shutdown();
  }
});

Deno.test("in-process initialization is session-scoped across maintenance rebinds", async () => {
  const contexts: Array<
    Readonly<{
      reconnecting: boolean;
      signal: AbortSignal;
    }>
  > = [];
  const reinitialized = createDeferred<void>();
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const worker = createWorker({
    id: "reinitializing-worker",
    transport: transportFor(hypervisor),
    workloads: { task: () => undefined },
    beforeReady(context) {
      contexts.push(context);
      if (context.reconnecting) reinitialized.resolve();
    },
  });
  const running = worker.closed;

  try {
    await worker.ready;
    await hypervisor.drain("reinitializing-worker");
    await reinitialized.promise;
    await waitUntil(() => worker.snapshot().state === "ready");

    assertEquals(contexts.map(({ reconnecting }) => reconnecting), [
      false,
      true,
    ]);
    assertEquals(contexts[0].signal.aborted, true);
    assertEquals(contexts[1].signal.aborted, false);
    assertEquals(worker.snapshot().state, "ready");
  } finally {
    await worker.stop("test_complete");
    assertEquals(await running, { reason: "stopped" });
    await hypervisor.shutdown();
  }
});

Deno.test("in-process Workers use the canonical heartbeat lease", async () => {
  let now = 0;
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
    clock: () => now,
    config: {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 500,
      leaseSweepIntervalMs: 10,
    },
  });
  const worker = createWorker({
    id: "bound-worker",
    transport: transportFor(hypervisor),
    workloads: { task: () => undefined },
  });
  const running = worker.closed;

  try {
    await worker.ready;
    assertEquals(hypervisor.sessions.get("bound-worker")?.phase, "ready");
    now = 10_000;
    assertEquals(hypervisor.sessions.expireLeases().length, 1);
    assertEquals(hypervisor.sessions.get("bound-worker"), undefined);
  } finally {
    await worker.stop("test_complete");
    await running;
    await hypervisor.shutdown();
  }
});

Deno.test("in-process streams remain bidirectional and runtime-neutral", async () => {
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  await connectLocal(hypervisor, {
    workerId: "stream-worker",
    workloads: {
      "media.stream": ({ input }) => ({
        metadata: { contentType: "text/plain" },
        body: input.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              const text = new TextDecoder().decode(chunk).toUpperCase();
              controller.enqueue(new TextEncoder().encode(text));
            },
          }),
        ),
      }),
    },
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("real"));
      controller.enqueue(new TextEncoder().encode("time"));
      controller.close();
    },
  });

  try {
    const handle = await hypervisor.dispatch({
      workload: "media.stream",
      body,
    });
    assertEquals(await handle.metadata, { contentType: "text/plain" });
    assertEquals(await readText(handle.output), "REALTIME");
    assertEquals((await handle.completed).status, "completed");
  } finally {
    await hypervisor.shutdown();
  }
});

Deno.test("capacity and exact worker targeting apply in process", async () => {
  const firstRelease = createDeferred<void>();
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  await connectLocal(hypervisor, {
    workerId: "worker-a",
    capacity: 1,
    workloads: {
      task: async () => {
        await firstRelease.promise;
      },
    },
  });
  await connectLocal(hypervisor, {
    workerId: "worker-b",
    capacity: 1,
    workloads: {
      task: () => ({ metadata: { worker: "b" } }),
    },
  });

  try {
    const first = await hypervisor.dispatch({
      workload: "task",
      target: { workerId: "worker-a" },
    });
    await first.started;
    const unavailable = await assertRejects(() =>
      hypervisor.dispatch({
        workload: "task",
        target: { workerId: "worker-a" },
      })
    );
    assertEquals((unavailable as Error).name, "HypervisorError");
    assertEquals(
      (unavailable as Error & { code: string }).code,
      "worker_unavailable",
    );

    const second = await hypervisor.dispatch({
      workload: "task",
      target: { workerId: "worker-b" },
    });
    assertEquals(await second.metadata, { worker: "b" });
    await readText(second.output);
    assertEquals((await second.completed).status, "completed");

    firstRelease.resolve();
    await readText(first.output);
    assertEquals((await first.completed).status, "completed");
  } finally {
    firstRelease.resolve();
    await hypervisor.shutdown();
  }
});

Deno.test("cancellation aborts an active in-process workload cooperatively", async () => {
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  await connectLocal(hypervisor, {
    workerId: "cancellable-worker",
    workloads: {
      wait: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  });

  try {
    const handle = await hypervisor.dispatch({ workload: "wait" });
    await handle.started;
    const completed = await handle.cancel("caller left");
    assertEquals(completed.status, "cancelled");
    assertEquals(completed.terminal, {
      code: "caller_cancelled",
      message: "caller left",
    });
    await assertRejects(() => handle.metadata);
    await assertRejects(() => readText(handle.output));
    assertEquals(hypervisor.sessions.get("cancellable-worker")?.reserved, 0);
  } finally {
    await hypervisor.shutdown();
  }
});

Deno.test("maintenance drain settles active work and rebinds the Worker", async () => {
  const release = createDeferred<void>();
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const worker = await connectLocal(hypervisor, {
    workerId: "draining-worker",
    workloads: {
      task: async () => {
        await release.promise;
      },
    },
  });
  const original = hypervisor.sessions.get("draining-worker")!;

  try {
    const handle = await hypervisor.dispatch({ workload: "task" });
    await handle.started;
    const draining = hypervisor.drain("draining-worker");
    assertEquals(
      hypervisor.sessions.get("draining-worker")?.phase,
      "draining",
    );
    await assertRejects(() => hypervisor.dispatch({ workload: "task" }));

    release.resolve();
    await readText(handle.output);
    assertEquals((await handle.completed).status, "completed");
    await draining;
    await waitUntil(() =>
      hypervisor.sessions.get("draining-worker")?.phase === "ready"
    );
    const replacement = hypervisor.sessions.get("draining-worker")!;
    assertEquals(replacement.phase, "ready");
    assertEquals(replacement.identity, original.identity);
    assertEquals(
      replacement.sessionGeneration,
      original.sessionGeneration + 1,
    );
    assertEquals(worker.snapshot().state, "ready");
    assertEquals(hypervisor.snapshot().inProcessWorkers, 1);

    const next = await hypervisor.dispatch({ workload: "task" });
    release.resolve();
    await readText(next.output);
    assertEquals((await next.completed).status, "completed");
  } finally {
    release.resolve();
    await hypervisor.shutdown();
  }
});

Deno.test("failed durable acceptance never starts or invokes in-process code", async () => {
  let invoked = false;
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.reject(new Error("store unavailable")),
  });
  await connectLocal(hypervisor, {
    workerId: "durable-worker",
    workloads: {
      task: () => {
        invoked = true;
      },
    },
  });

  try {
    const handle = await hypervisor.dispatch({ workload: "task" });
    await assertRejects(
      () => handle.started,
      Error,
      "acceptance persistence did not confirm",
    );
    assertEquals((await handle.completed).status, "indeterminate");
    assertEquals(invoked, false);
    assertEquals(hypervisor.sessions.get("durable-worker")?.reserved, 0);
  } finally {
    await hypervisor.shutdown();
  }
});

Deno.test("deadline cancellation reaches the active in-process handler", async () => {
  let aborted = false;
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  await connectLocal(hypervisor, {
    workerId: "deadline-worker",
    workloads: {
      task: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        }),
    },
  });

  try {
    const handle = await hypervisor.dispatch({
      workload: "task",
      deadlineAtMs: Date.now() + 10,
    });
    await handle.started;
    const terminal = await handle.completed;
    assertEquals(terminal.status, "cancelled");
    assertEquals(terminal.terminal, {
      code: "deadline_exceeded",
      message: "deadline_exceeded",
    });
    assertEquals(aborted, true);
  } finally {
    await hypervisor.shutdown();
  }
});

Deno.test("cancelling output propagates to the workload stream", async () => {
  let outputCancelled = false;
  let handlerAborted = false;
  const hypervisor = createHypervisor({
    commitAcceptedWork: () => Promise.resolve(),
  });
  await connectLocal(hypervisor, {
    workerId: "output-worker",
    workloads: {
      stream: ({ signal }) => {
        signal.addEventListener("abort", () => handlerAborted = true, {
          once: true,
        });
        return {
          metadata: { streaming: true },
          body: new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              outputCancelled = true;
            },
          }),
        };
      },
    },
  });

  try {
    const handle = await hypervisor.dispatch({ workload: "stream" });
    assertEquals(await handle.metadata, { streaming: true });
    await handle.output.cancel("consumer stopped");
    const terminal = await handle.completed;
    assertEquals(terminal.status, "cancelled");
    assertEquals(terminal.terminal, {
      code: "caller_cancelled",
      message: "consumer stopped",
    });
    assertEquals(outputCancelled, true);
    assertEquals(handlerAborted, true);
  } finally {
    await hypervisor.shutdown();
  }
});
