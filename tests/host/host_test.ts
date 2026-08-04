import { assertEquals, assertRejects } from "@std/assert";
import type { AcceptanceCommit } from "../../src/supervisor/index.ts";
import { createWorkerHost } from "../../src/host/host.ts";

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

Deno.test("in-process work starts only after durable acceptance commits", async () => {
  const persistence = createDeferred<void>();
  let accepted: AcceptanceCommit | undefined;
  let invoked = false;
  const host = createWorkerHost({
    persistAcceptance(commit) {
      accepted = commit;
      return persistence.promise;
    },
  });
  const worker = host.attachInProcessWorker({
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
    const handle = await host.dispatch({
      workload: "copilotz.turn",
      metadata: { conversationId: "conversation-1" },
    });
    let started = false;
    void handle.started.then(() => started = true);
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(invoked, false);
    assertEquals(started, false);
    assertEquals(accepted?.metadata, {
      conversationId: "conversation-1",
    });
    assertEquals(
      accepted?.assignment.fence.identity,
      worker.identity,
    );

    persistence.resolve();
    await handle.started;
    assertEquals(invoked, true);
    assertEquals(await handle.metadata, { channel: "text" });
    assertEquals(await readText(handle.output), "done");
    assertEquals((await handle.completed).status, "completed");
    assertEquals(host.sessions.get("embedded-worker")?.reserved, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("in-process streams remain bidirectional and runtime-neutral", async () => {
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  host.attachInProcessWorker({
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
    const handle = await host.dispatch({
      workload: "media.stream",
      body,
    });
    assertEquals(await handle.metadata, { contentType: "text/plain" });
    assertEquals(await readText(handle.output), "REALTIME");
    assertEquals((await handle.completed).status, "completed");
  } finally {
    await host.shutdown();
  }
});

Deno.test("capacity and exact worker targeting apply in process", async () => {
  const firstRelease = createDeferred<void>();
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  host.attachInProcessWorker({
    workerId: "worker-a",
    capacity: 1,
    workloads: {
      task: async () => {
        await firstRelease.promise;
      },
    },
  });
  host.attachInProcessWorker({
    workerId: "worker-b",
    capacity: 1,
    workloads: {
      task: () => ({ metadata: { worker: "b" } }),
    },
  });

  try {
    const first = await host.dispatch({
      workload: "task",
      target: { workerId: "worker-a" },
    });
    await first.started;
    const unavailable = await assertRejects(() =>
      host.dispatch({
        workload: "task",
        target: { workerId: "worker-a" },
      })
    );
    assertEquals((unavailable as Error).name, "WorkerHostError");
    assertEquals(
      (unavailable as Error & { code: string }).code,
      "worker_unavailable",
    );

    const second = await host.dispatch({
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
    await host.shutdown();
  }
});

Deno.test("cancellation aborts an active in-process workload cooperatively", async () => {
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  host.attachInProcessWorker({
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
    const handle = await host.dispatch({ workload: "wait" });
    await handle.started;
    const completed = await handle.cancel("caller left");
    assertEquals(completed.status, "cancelled");
    assertEquals(completed.terminal?.message, "caller left");
    await assertRejects(() => handle.metadata);
    await assertRejects(() => readText(handle.output));
    assertEquals(host.sessions.get("cancellable-worker")?.reserved, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("drain stops admission and detaches after active work settles", async () => {
  const release = createDeferred<void>();
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  const worker = host.attachInProcessWorker({
    workerId: "draining-worker",
    workloads: {
      task: async () => {
        await release.promise;
      },
    },
  });

  try {
    const handle = await host.dispatch({ workload: "task" });
    await handle.started;
    const draining = worker.drain();
    assertEquals(worker.snapshot().state, "draining");
    await assertRejects(() => host.dispatch({ workload: "task" }));

    release.resolve();
    await readText(handle.output);
    assertEquals((await handle.completed).status, "completed");
    await draining;
    assertEquals(worker.snapshot().state, "drained");
    assertEquals(host.sessions.get("draining-worker"), undefined);
    assertEquals(host.snapshot().workers, 0);
  } finally {
    release.resolve();
    await host.shutdown();
  }
});

Deno.test("unknown acceptance persistence never invokes in-process code", async () => {
  let invoked = false;
  const host = createWorkerHost({
    persistAcceptance: () => Promise.reject(new Error("store unavailable")),
  });
  host.attachInProcessWorker({
    workerId: "durable-worker",
    workloads: {
      task: () => {
        invoked = true;
      },
    },
  });

  try {
    const handle = await host.dispatch({ workload: "task" });
    const terminal = await handle.completed;
    assertEquals(terminal.status, "indeterminate");
    assertEquals(
      terminal.terminal?.code,
      "acceptance_persistence_unknown",
    );
    assertEquals(invoked, false);
    await assertRejects(() => handle.started);
    await assertRejects(() => handle.metadata);
    await assertRejects(() => readText(handle.output));
    assertEquals(host.sessions.get("durable-worker")?.reserved, 0);
  } finally {
    await host.shutdown();
  }
});

Deno.test("deadline cancellation reaches the active in-process handler", async () => {
  let aborted = false;
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  host.attachInProcessWorker({
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
    const handle = await host.dispatch({
      workload: "task",
      deadlineAtMs: Date.now() + 10,
    });
    await handle.started;
    const terminal = await handle.completed;
    assertEquals(terminal.status, "cancelled");
    assertEquals(terminal.terminal?.message, "work deadline elapsed");
    assertEquals(aborted, true);
  } finally {
    await host.shutdown();
  }
});

Deno.test("cancelling output propagates to the workload stream", async () => {
  let outputCancelled = false;
  let handlerAborted = false;
  const host = createWorkerHost({
    persistAcceptance: () => Promise.resolve(),
  });
  host.attachInProcessWorker({
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
    const handle = await host.dispatch({ workload: "stream" });
    assertEquals(await handle.metadata, { streaming: true });
    await handle.output.cancel("consumer stopped");
    const terminal = await handle.completed;
    assertEquals(terminal.status, "cancelled");
    assertEquals(terminal.terminal?.message, "consumer stopped");
    assertEquals(outputCancelled, true);
    assertEquals(handlerAborted, true);
  } finally {
    await host.shutdown();
  }
});
