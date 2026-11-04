import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "../adapters/node/server.ts";
import { createHypervisor } from "../hypervisor/hypervisor.ts";
import type { Hypervisor, WorkerCallOptions } from "../hypervisor/types.ts";
import type { WorkerTransport } from "../transport/declarations.ts";
import type { HypervisorLifecycleCallbacks } from "../lifecycle/index.ts";
import type { HostCallHandle } from "../work/host-call.ts";
import type { Worker, WorkerWorkHandler } from "./types.ts";
import { createWorker } from "./worker.ts";

// A tiny stream lifetime makes every few calls spend a connection, so these
// tests cross many make-before-break handoffs.

const bytes = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function text(call: HostCallHandle): Promise<string> {
  const result = await new Response(call.output).text();
  await call.completed;
  return result;
}
async function until(check: () => boolean, message: string, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(2);
  }
}

async function fixture(
  kind: "in-process" | "websocket",
  options: Readonly<{
    calls: WorkerCallOptions;
    handler: WorkerWorkHandler;
    maxLifetimeStreams: number;
    capacity?: number;
    queued?: boolean;
    /** Holds admission of the given session generation. */
    admitted?: (generation: number) => void | Promise<void>;
    callbacks?: HypervisorLifecycleCallbacks;
    reconnectDelayMs?: number;
  }>,
) {
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const identity = {
    workerId: "handoff-worker",
    attemptId: crypto.randomUUID(),
    epoch: 1,
  };
  const capacity = options.capacity ?? 1;
  let generation = 0;
  const h = createHypervisor(
    {
      transports:
        kind === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
      workerCalls: options.calls,
      config: {
        maxLifetimeStreams: options.maxLifetimeStreams,
        shutdownTimeoutMs: 1000,
        heartbeatIntervalMs: 200,
        leaseTimeoutMs: 2000,
        leaseSweepIntervalMs: 100,
        ...(options.queued
          ? { maxQueuedDispatches: 100, dispatchQueueTimeoutMs: 5000 }
          : {}),
      },
      admit: async ({ credential }) => {
        const sessionGeneration = ++generation;
        await options.admitted?.(sessionGeneration);
        return {
          definition: {
            workerId: identity.workerId,
            providerId: "test",
            workloads: ["action"],
            capacity,
            providerConfig: {},
            labels: {},
          },
          sessionGeneration,
          authenticatedWith: credential.kind,
          resume: {
            credential: { kind: "resume", capability: "resume-test" },
            expiresAtMs: Date.now() + 60_000,
          },
        };
      },
    },
    options.callbacks,
  );
  const listener =
    kind === "websocket" ? await serve({ hypervisor: h }) : undefined;
  const url = listener ? new URL("/workers", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const transport: WorkerTransport = url
    ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
    : local;
  const worker: Worker = createWorker({
    id: identity.workerId,
    transport,
    capacity,
    hostCalls: { maxConcurrent: 16, timeoutMs: 5000 },
    activate: () => identity,
    register: () => ({
      credential: { kind: "registration", capability: "registration-test" },
      expiresAtMs: Date.now() + 60_000,
    }),
    reconnectDelay:
      options.reconnectDelayMs === undefined
        ? false
        : () => options.reconnectDelayMs!,
    workloads: { action: options.handler },
  });
  await worker.ready;
  return {
    h,
    worker,
    async close() {
      await worker.stop();
      await h.shutdown();
      await listener?.shutdown();
    },
  };
}

async function invoke(h: Hypervisor, metadata = {}) {
  const handle = await h.dispatch({
    workload: "action",
    metadata,
    deadlineAtMs: Date.now() + 10_000,
  });
  const result = await new Response(handle.output).text();
  assert.equal((await handle.completed).status, "completed");
  return result;
}

for (const kind of ["in-process", "websocket"] as const) {
  test(`${kind}: calls across many spent connections never fail`, {
    timeout: 30_000,
  }, async () => {
    // Each Action's calls, by the connection that carried them.
    const routes = new Map<string, Set<string>>();
    const connections = new Set<string>();
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      calls: {
        admit(context) {
          const job = context.parent!.operationId;
          const seen = routes.get(job) ?? new Set<string>();
          seen.add(context.fence.connectionId);
          routes.set(job, seen);
          connections.add(context.fence.connectionId);
          return () => bytes(String(context.metadata.n));
        },
        admitUnassigned: () => () => bytes("unassigned"),
      },
      handler: async ({ callHost }) => {
        let sum = 0;
        for (let n = 0; n < 12; n++) {
          sum += Number(
            await text(await callHost({ workload: "op", metadata: { n } })),
          );
        }
        return bytes(String(sum));
      },
    });
    try {
      for (let i = 0; i < 8; i++) assert.equal(await invoke(f.h), "66");
      for (let i = 0; i < 16; i++) {
        assert.equal(
          await text(await f.worker.callHost({ workload: "receipt" })),
          "unassigned",
        );
      }
      // 96 parent calls over a 4-stream worker share took many connections,
      // and Actions kept calling over successors of their own connection.
      assert.ok(connections.size >= 16, `only ${connections.size} connections`);
      assert.ok(
        [...routes.values()].every((seen) => seen.size > 1),
        "every Action called across a handoff",
      );
      // Handed-off connections close once their streams finish.
      await until(
        () => f.h.snapshot().connections === 1,
        "predecessors closed",
      );
      assert.equal(f.worker.snapshot().state, "ready");
    } finally {
      await f.close();
    }
  });

  test(`${kind}: concurrent calls past the remaining lifetime wait for the successor`, {
    timeout: 10_000,
  }, async () => {
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      calls: { admit: (context) => () => bytes(String(context.metadata.n)) },
      handler: async ({ callHost }) => {
        // Six Opens at once against a 4-stream share: none may be refused.
        const calls = await Promise.all(
          Array.from({ length: 6 }, (_, n) =>
            callHost({ workload: "op", metadata: { n } }),
          ),
        );
        const results = await Promise.all(calls.map(text));
        return bytes(results.join(","));
      },
    });
    try {
      assert.equal(await invoke(f.h), "0,1,2,3,4,5");
      assert.equal(await invoke(f.h), "0,1,2,3,4,5");
    } finally {
      await f.close();
    }
  });

  test(`${kind}: in-flight streams finish on the old connection after the successor takes over`, {
    timeout: 10_000,
  }, async () => {
    const held = latch();
    const release = latch();
    const carriedBy = new Map<string, string>();
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      calls: {
        admit(context) {
          carriedBy.set(
            String(context.metadata.name),
            context.fence.connectionId,
          );
          if (context.metadata.name === "slow")
            return async () => {
              held.resolve();
              await release.promise;
              return bytes("slow");
            };
          return () => bytes(String(context.metadata.name));
        },
      },
      handler: async ({ callHost, metadata }) => {
        if (metadata.phase === "later")
          return bytes(
            await text(
              await callHost({ workload: "op", metadata: { name: "later" } }),
            ),
          );
        // The slow call stays open on the first connection while three more
        // spend its worker share and the next one rides the successor.
        const slow = await callHost({
          workload: "op",
          metadata: { name: "slow" },
        });
        await held.promise;
        const quick: string[] = [];
        for (const name of ["a", "b", "c", "d"]) {
          quick.push(
            await text(await callHost({ workload: "op", metadata: { name } })),
          );
        }
        return bytes([await text(slow), ...quick].join(","));
      },
    });
    try {
      const first = f.h.sessions.get("handoff-worker")!.connectionId;
      const running = invoke(f.h, { phase: "first" });
      await until(
        () => carriedBy.has("d"),
        "the parent called over the successor",
      );
      const second = f.h.sessions.get("handoff-worker")!.connectionId;
      assert.notEqual(second, first, "a successor took over");
      assert.equal(carriedBy.get("slow"), first);
      assert.equal(carriedBy.get("d"), second);
      // The old connection still holds the parent and its slow call.
      assert.equal(f.h.snapshot().connections, 2);
      release.resolve();
      assert.equal(await running, "slow,a,b,c,d");
      await until(
        () => f.h.snapshot().connections === 1,
        "the old connection closed once its streams finished",
      );
      // New work runs on the successor.
      assert.equal(await invoke(f.h, { phase: "later" }), "later");
      assert.equal(carriedBy.get("later"), second);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  test(`${kind}: forward work across many handoffs never fails`, {
    timeout: 30_000,
  }, async () => {
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      capacity: 4,
      queued: true,
      calls: { admit: () => () => bytes("ok") },
      handler: async ({ callHost }) =>
        bytes(await text(await callHost({ workload: "op" }))),
    });
    try {
      const connections = new Set<string>();
      for (let round = 0; round < 6; round++) {
        connections.add(f.h.sessions.get("handoff-worker")!.connectionId);
        const results = await Promise.all(
          Array.from({ length: 4 }, () => invoke(f.h)),
        );
        assert.deepEqual(results, ["ok", "ok", "ok", "ok"]);
      }
      assert.ok(connections.size >= 3, `only ${connections.size} connections`);
    } finally {
      await f.close();
    }
  });
}

for (const kind of ["in-process", "websocket"] as const) {
  test(`${kind}: a shutdown while the successor connects stops the worker`, {
    timeout: 10_000,
  }, async () => {
    const successor = latch();
    const hold = latch();
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      calls: { admit: () => undefined, admitUnassigned: () => () => bytes("") },
      handler: () => undefined,
      admitted: async (generation) => {
        if (generation < 2) return;
        successor.resolve();
        await hold.promise;
      },
    });
    try {
      // Three calls reach the low-water mark; the successor is then held.
      for (let i = 0; i < 3; i++) {
        await text(await f.worker.callHost({ workload: "receipt" }));
      }
      await successor.promise;
      await f.h.shutdownWorker("handoff-worker");
      assert.equal((await f.worker.closed).reason, "shutdown");
      hold.resolve();
      await sleep(20);
      assert.equal(f.h.sessions.get("handoff-worker"), undefined);
    } finally {
      hold.resolve();
      await f.close();
    }
  });

  test(`${kind}: a successor refused before ready leaves its predecessor serving`, {
    timeout: 10_000,
  }, async () => {
    let refused = 0;
    const f = await fixture(kind, {
      maxLifetimeStreams: 8,
      reconnectDelayMs: 20,
      calls: { admit: (context) => () => bytes(String(context.metadata.n)) },
      callbacks: {
        onReady: ({ fence }) => {
          // The first successor fails after it attached, before it is ready.
          if (fence.sessionGeneration === 2) {
            refused++;
            throw new Error("not this one");
          }
        },
      },
      handler: async ({ callHost }) => {
        let sum = 0;
        for (let n = 0; n < 8; n++) {
          sum += Number(
            await text(await callHost({ workload: "op", metadata: { n } })),
          );
        }
        return bytes(String(sum));
      },
    });
    try {
      for (let i = 0; i < 5; i++) assert.equal(await invoke(f.h), "28");
      assert.equal(refused, 1);
      assert.equal(f.worker.snapshot().state, "ready");
    } finally {
      await f.close();
    }
  });
}
