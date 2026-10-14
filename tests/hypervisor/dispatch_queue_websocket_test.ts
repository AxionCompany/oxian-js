import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects } from "../support/assert.ts";
import { serve } from "../../src/adapters/node/index.ts";
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
  assert.deepStrictEqual((error as Error & { code: string }).code, expected);
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
  const listener = await serve({ hypervisor, hostname: "127.0.0.1", port: 0 });
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
test("WebSocket dispatch queue completes 20 concurrent dispatches at capacity 8 in FIFO order", async () => {
  const h = await harness(8);
  try {
    const results = Array.from(
      { length: 20 },
      (_, order) => h.dispatch(order, order < 8).then(consume),
    );
    const all = Promise.all(results);
    await waitFor(() => h.started.length === 8);
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 12);
    h.release.resolve();
    assert.deepStrictEqual(
      await bounded(all),
      Array.from({ length: 20 }, (_, i) => String(i)),
    );
    assert.deepStrictEqual(h.started, Array.from({ length: 20 }, (_, i) => i));
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 0);
  } finally {
    await h.close();
  }
});

test("WebSocket dispatch queue expires deadlines, aborts, rejects overflow, and removes cancelled entries", async () => {
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
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 2);
    await code(h.dispatch(3), "dispatch_queue_full");
    abort.abort("cancel queued");
    await cancelled;
    await deadline;
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 0);
    assert.deepStrictEqual(h.started, [0]);
    const survivor = h.dispatch(4).then(consume);
    h.release.resolve();
    await bounded(active);
    assert.deepStrictEqual(await bounded(survivor), "4");
    assert.deepStrictEqual(h.started, [0, 4]);
  } finally {
    await h.close();
  }
});

test("WebSocket dispatch queue rejects queued work immediately on shutdown", async () => {
  const h = await harness();
  try {
    const active = consume(await h.dispatch(0, true));
    const waiting = code(h.dispatch(1), "shutting_down");
    const shutdown = h.hypervisor.shutdown();
    await waiting;
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 0);
    await code(h.dispatch(2), "shutting_down");
    h.release.resolve();
    await bounded(active);
    await bounded(shutdown);
    assert.deepStrictEqual(h.started, [0]);
  } finally {
    await h.close();
  }
});

test("WebSocket dispatch queue waits for an absent target to reconnect within its deadline", async () => {
  const h = await harness();
  try {
    const previous = h.hypervisor.sessions.get(h.identity.workerId)!;
    h.disconnect();
    await waitFor(() =>
      h.hypervisor.sessions.get(h.identity.workerId) === undefined
    );
    const pending = h.dispatch(1).then(consume);
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 1);
    h.reconnect.resolve(0);
    assert.deepStrictEqual(await bounded(pending), "1");
    const current = h.hypervisor.sessions.get(h.identity.workerId)!;
    assert.ok(current.sessionGeneration > previous.sessionGeneration);
    assert.deepStrictEqual(current.identity, previous.identity);
    assert.deepStrictEqual(h.hypervisor.snapshot().queuedDispatches, 0);
  } finally {
    await h.close();
  }
});

test("WebSocket drain rejects queued targeted work without executing it", async () => {
  const h = await harness();
  try {
    const active = consume(await h.dispatch(0, true));
    const waiting = code(h.dispatch(1), "worker_draining");
    const drain = h.hypervisor.drain(h.identity.workerId);
    await waiting;
    h.release.resolve();
    await bounded(active);
    await bounded(drain);
    assert.deepStrictEqual(h.started, [0]);
  } finally {
    await h.close();
  }
});
