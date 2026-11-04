import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "../adapters/node/server.ts";
import { createHypervisor } from "../hypervisor/hypervisor.ts";
import type { Hypervisor } from "../hypervisor/types.ts";
import type { WorkerTransport } from "../transport/declarations.ts";
import type { HostCallHandle } from "../work/host-call.ts";
import type { Worker } from "./types.ts";
import { createWorker } from "./worker.ts";

// Far more concurrent work than any queue bound: senders wait their turn and
// readers hold their peer back, so nothing is refused or disconnected.

const body = (size: number) => new Uint8Array(size).fill(7);
async function size(call: HostCallHandle): Promise<number> {
  const length = (await new Response(call.output).arrayBuffer()).byteLength;
  await call.completed;
  return length;
}

async function fixture(
  kind: "in-process" | "websocket",
  maxLifetimeStreams?: number,
) {
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const identity = {
    workerId: "busy-worker",
    attemptId: crypto.randomUUID(),
    epoch: 1,
  };
  let generation = 0;
  const disconnects: string[] = [];
  const h = createHypervisor(
    {
      transports:
        kind === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
      workerCalls: {
        maxConcurrent: 4_096,
        maxPerConnection: 1_024,
        timeoutMs: 60_000,
        admit:
          () =>
          async ({ input }) =>
            body((await new Response(input).arrayBuffer()).byteLength),
        admitUnassigned: () => () => body(16),
      },
      config: {
        maxQueuedDispatches: 10_000,
        dispatchQueueTimeoutMs: 60_000,
        ...(maxLifetimeStreams === undefined ? {} : { maxLifetimeStreams }),
      },
      admit: ({ credential }) => ({
        definition: {
          workerId: identity.workerId,
          providerId: "test",
          workloads: ["action"],
          capacity: 256,
          providerConfig: {},
          labels: {},
        },
        sessionGeneration: ++generation,
        authenticatedWith: credential.kind,
        resume: {
          credential: { kind: "resume", capability: "resume-test" },
          expiresAtMs: Date.now() + 60_000,
        },
      }),
    },
    { onDisconnect: ({ reason }) => void disconnects.push(reason) },
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
    capacity: 256,
    hostCalls: { maxConcurrent: 1_024, timeoutMs: 60_000 },
    activate: () => identity,
    register: () => ({
      credential: { kind: "registration", capability: "registration-test" },
      expiresAtMs: Date.now() + 60_000,
    }),
    workloads: {
      action: async ({ callHost, input }) => {
        const received = (await new Response(input).arrayBuffer()).byteLength;
        const [first, second] = await Promise.all(
          [0, 1].map(async () =>
            size(await callHost({ workload: "op", body: body(4_096) })),
          ),
        );
        return body(received + first! + second! - 8_192);
      },
    },
  });
  await worker.ready;
  return {
    h,
    worker,
    disconnects,
    async close() {
      await worker.stop();
      await h.shutdown();
      await listener?.shutdown();
    },
  };
}

async function invoke(h: Hypervisor): Promise<number> {
  const handle = await h.dispatch({
    workload: "action",
    body: body(4_096),
    deadlineAtMs: Date.now() + 60_000,
  });
  const length = (await new Response(handle.output).arrayBuffer()).byteLength;
  assert.equal((await handle.completed).status, "completed");
  return length;
}

for (const kind of ["in-process", "websocket"] as const) {
  test(`${kind}: 512 concurrent Actions with host calls share one connection`, {
    timeout: 60_000,
  }, async () => {
    const f = await fixture(kind);
    try {
      const connection = f.worker.snapshot().connectionId;
      const sizes = await Promise.all(
        Array.from({ length: 512 }, () => invoke(f.h)),
      );
      assert.ok(sizes.every((length) => length === 4_096));
      assert.equal(f.worker.snapshot().connectionId, connection);
      assert.deepEqual(f.disconnects, []);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: a burst of 1,000 concurrent host calls never drops the connection`, {
    timeout: 60_000,
  }, async () => {
    const f = await fixture(kind);
    try {
      const connection = f.worker.snapshot().connectionId;
      const sizes = await Promise.all(
        Array.from({ length: 1_000 }, async () =>
          size(await f.worker.callHost({ workload: "receipt" })),
        ),
      );
      assert.ok(sizes.every((length) => length === 16));
      assert.equal(f.worker.snapshot().connectionId, connection);
      assert.deepEqual(f.disconnects, []);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: backpressure holds across connection handoffs`, {
    timeout: 60_000,
  }, async () => {
    // 256 concurrent Actions spend a 512-stream lifetime several times over.
    const f = await fixture(kind, 512);
    try {
      const sizes = await Promise.all(
        Array.from({ length: 256 }, () => invoke(f.h)),
      );
      assert.ok(sizes.every((length) => length === 4_096));
      assert.ok(f.disconnects.every((reason) => reason === "rotation"));
    } finally {
      await f.close();
    }
  });
}
