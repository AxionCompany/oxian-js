import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "../../src/adapters/deno/index.ts";
import {
  createEphemeralCredentialLifecycle,
  createEphemeralWorkerStore,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";
import type { WorkHandle } from "../../src/work/types.ts";
import {
  createProtocolTestHypervisor,
  TEST_WORKER_PATH,
} from "./protocol_hypervisor.ts";
import { createProtocolTestWorker } from "../worker/protocol_worker.ts";

async function waitFor(predicate: () => boolean) {
  const end = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= end) {
      throw new Error("WebSocket test condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("WebSocket operation timed out")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function code(promise: Promise<unknown>, expected: string) {
  const error = await assertRejects(() => bounded(promise));
  assertEquals((error as Error & { code: string }).code, expected);
}
async function consume(handle: WorkHandle) {
  const text = await new Response(handle.output).text();
  await handle.completed;
  return text;
}

async function harness(capacity = 1, maxQueuedDispatches = 32) {
  const repository = createEphemeralWorkerStore();
  await repository.define(
    createWorkerDefinition({
      workerId: "queue-worker",
      providerId: "attached",
      workloads: ["job"],
      capacity,
    }),
  );
  const identity = (await repository.activate("queue-worker")).attempt.identity;
  const authority = createEphemeralCredentialLifecycle();
  const registration = await authority.issueRegistration(identity);
  const hypervisor = createProtocolTestHypervisor({
    control: { authority, repository },
    commitAcceptedWork: async () => {},
    config: {
      maxQueuedDispatches,
      dispatchQueueTimeoutMs: 4_000,
      heartbeatIntervalMs: 50,
      leaseTimeoutMs: 2_000,
      leaseSweepIntervalMs: 20,
      shutdownTimeoutMs: 300,
    },
  });
  const listener = serve({ hypervisor, hostname: "127.0.0.1", port: 0 });
  const url = new URL(TEST_WORKER_PATH, listener.url);
  url.protocol = "ws:";
  const release = Promise.withResolvers<void>();
  const reconnect = Promise.withResolvers<number>();
  let socket: WebSocket | undefined;
  const started: number[] = [];
  const worker = createProtocolTestWorker({
    identity,
    credential: registration.credential,
    credentialPersistence: "ephemeral",
    capacity,
    transport: {
      type: "websocket",
      url,
      allowInsecureLoopback: true,
      socket: ({ url, protocol }) => {
        socket = new WebSocket(url, protocol);
        return socket;
      },
    },
    reconnectDelay: () => reconnect.promise,
    workloads: {
      job: async ({ metadata }) => {
        started.push(Number(metadata.order));
        if (metadata.hold) await release.promise;
        return new TextEncoder().encode(String(metadata.order));
      },
    },
  });
  const close = async () => {
    release.resolve();
    reconnect.resolve(0);
    await worker.stop("cleanup");
    await hypervisor.shutdown();
    await listener.shutdown();
  };
  try {
    await bounded(worker.ready);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    hypervisor,
    worker,
    listener,
    identity,
    release,
    reconnect,
    started,
    close,
    disconnect() {
      socket!.close(4000, "test connection loss");
    },
    dispatch(order: number, hold = false) {
      return hypervisor.dispatch({
        workload: "job",
        target: { workerId: identity.workerId },
        metadata: { order, hold },
        deadlineAtMs: Date.now() + 4_000,
      });
    },
  };
}
const permission = await Deno.permissions.query({
  name: "net",
  host: "127.0.0.1",
});

Deno.test({
  name:
    "WebSocket dispatch queue completes 20 concurrent dispatches at capacity 8 in FIFO order",
  ignore: permission.state !== "granted",
  async fn() {
    const h = await harness(8);
    try {
      const results = Array.from(
        { length: 20 },
        (_, order) => h.dispatch(order, order < 8).then(consume),
      );
      const all = Promise.all(results);
      await waitFor(() => h.started.length === 8);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 12);
      h.release.resolve();
      assertEquals(
        await bounded(all),
        Array.from({ length: 20 }, (_, i) => String(i)),
      );
      assertEquals(h.started, Array.from({ length: 20 }, (_, i) => i));
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name:
    "WebSocket dispatch queue expires deadlines, aborts, rejects overflow, and removes cancelled entries",
  ignore: permission.state !== "granted",
  async fn() {
    const h = await harness(1, 2);
    try {
      const active = consume(await h.dispatch(0, true));
      await waitFor(() => h.started.length === 1);
      const abort = new AbortController();
      const deadline = code(
        h.hypervisor.dispatch({
          workload: "job",
          deadlineAtMs: Date.now() + 60,
        }),
        "deadline_exceeded",
      );
      const cancelled = code(
        h.hypervisor.dispatch({ workload: "job", signal: abort.signal }),
        "dispatch_aborted",
      );
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 2);
      await code(h.dispatch(3), "dispatch_queue_full");
      abort.abort("cancel queued");
      await cancelled;
      await deadline;
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 0);
      assertEquals(h.started, [0]);
      const survivor = h.dispatch(4).then(consume);
      h.release.resolve();
      await bounded(active);
      assertEquals(await bounded(survivor), "4");
      assertEquals(h.started, [0, 4]);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "WebSocket dispatch queue rejects queued work immediately on shutdown",
  ignore: permission.state !== "granted",
  async fn() {
    const h = await harness();
    try {
      const active = consume(await h.dispatch(0, true));
      const waiting = code(h.dispatch(1), "shutting_down");
      const shutdown = h.hypervisor.shutdown();
      await waiting;
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 0);
      await code(h.dispatch(2), "shutting_down");
      h.release.resolve();
      await bounded(active);
      await bounded(shutdown);
      assertEquals(h.started, [0]);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name:
    "WebSocket dispatch queue waits for an absent target to reconnect within its deadline",
  ignore: permission.state !== "granted",
  async fn() {
    const h = await harness();
    try {
      const previous = h.hypervisor.sessions.get(h.identity.workerId)!;
      h.disconnect();
      await waitFor(() =>
        h.hypervisor.sessions.get(h.identity.workerId) === undefined
      );
      const pending = h.dispatch(1).then(consume);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 1);
      h.reconnect.resolve(0);
      assertEquals(await bounded(pending), "1");
      const current = h.hypervisor.sessions.get(h.identity.workerId)!;
      assert(current.sessionGeneration > previous.sessionGeneration);
      assertEquals(current.identity, previous.identity);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 0);
    } finally {
      await h.close();
    }
  },
});

Deno.test({
  name: "WebSocket drain rejects queued targeted work without executing it",
  ignore: permission.state !== "granted",
  async fn() {
    const h = await harness();
    try {
      const active = consume(await h.dispatch(0, true));
      const waiting = code(h.dispatch(1), "worker_draining");
      const drain = h.hypervisor.drain(h.identity.workerId);
      await waiting;
      h.release.resolve();
      await bounded(active);
      await bounded(drain);
      assertEquals(h.started, [0]);
    } finally {
      await h.close();
    }
  },
});
