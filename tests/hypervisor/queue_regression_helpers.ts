import { serve } from "../../src/adapters/deno/index.ts";
import type {
  HypervisorLifecycleCallbacks,
  WorkerLifecycleCallbacks,
} from "../../src/lifecycle/index.ts";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import {
  createWorker,
  type WorkerWorkHandler,
} from "../../src/worker/index.ts";
import {
  createEphemeralCredentialLifecycle,
  createEphemeralWorkerStore,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";
import type { WorkInput } from "../../src/work/types.ts";

export async function bounded<T>(
  promise: Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("queue regression timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function queueHarness(
  type: "in-process" | "websocket",
  handler: WorkerWorkHandler,
  callbacks: WorkerLifecycleCallbacks = {},
  capacity = 1,
  maxQueuedDispatches = 16,
  hostCallbacks: HypervisorLifecycleCallbacks = {},
) {
  const repository = createEphemeralWorkerStore();
  const authority = createEphemeralCredentialLifecycle();
  for (const workerId of ["A", "B"]) {
    await repository.define(
      createWorkerDefinition({
        workerId,
        providerId: "attached",
        workloads: ["exec"],
        capacity,
      }),
    );
  }
  const local = {
    type: "in-process",
    config: { topic: `queue-regression-${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({
    transports: type === "in-process"
      ? [local]
      : [{ type: "websocket", config: { path: "/workers" } }],
    admit: async ({ identity, credential, handshakeId }) => {
      await repository.assertCurrent(identity);
      const exchange = await authority.exchange({
        identity,
        credential,
        handshakeId,
      });
      return {
        definition: (await repository.getDefinition(identity.workerId))!,
        sessionGeneration: exchange.sessionGeneration,
        authenticatedWith: exchange.authenticatedWith,
        resume: exchange.resume,
      };
    },
    config: {
      maxQueuedDispatches,
      dispatchQueueTimeoutMs: 10_000,
      shutdownTimeoutMs: 500,
    },
  }, hostCallbacks);
  const listener = type === "websocket"
    ? serve({ hypervisor, hostname: "127.0.0.1", port: 0 })
    : undefined;
  const url = listener === undefined
    ? undefined
    : new URL("/workers", listener.url);
  if (url !== undefined) url.protocol = "ws:";
  const workers = ["A", "B"].map((id) =>
    createWorker({
      id,
      capacity,
      transport: url === undefined
        ? local
        : { type: "websocket", config: { url, allowInsecureLoopback: true } },
      activate: async ({ workerId }) =>
        (await repository.activate(workerId)).attempt.identity,
      register: ({ identity }) => authority.issueRegistration(identity),
      workloads: { exec: handler },
    }, callbacks)
  );
  const close = async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    await hypervisor.shutdown();
    await listener?.shutdown();
  };
  try {
    await bounded(Promise.all(workers.map((worker) => worker.ready)));
  } catch (error) {
    await close();
    throw error;
  }
  const run = async (input: Omit<WorkInput, "workload">) => {
    const handle = await hypervisor.dispatch({
      workload: "exec",
      deadlineAtMs: Date.now() + 10_000,
      ...input,
    });
    const output = await new Response(handle.output).text();
    await handle.completed;
    return output;
  };
  return { hypervisor, workers, run, close };
}
