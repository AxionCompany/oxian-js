import assert from "node:assert/strict";
import { test } from "node:test";
import { createHypervisor } from "../hypervisor/hypervisor.ts";
import {
  createReadyAckFrame,
  createWelcomeFrame,
  createWorkAcceptedFrame,
  withHostCallCapacity,
  type ControlFrame,
} from "../protocol/index.ts";
import { bindInProcessFabric } from "../transport/in-process.ts";
import {
  createFrameConnection,
  createProtocolTransport,
} from "../transport/index.ts";
import { isHostCallError } from "../work/host-call.ts";
import { createWorker } from "./worker.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("in-process: a lost work.start remains indeterminate without automatic replay", {
  timeout: 5000,
}, async () => {
  const topic = crypto.randomUUID();
  const handshake = deferred<void>();
  let startsDropped = 0;
  let opens = 0;
  let startsReceived = 0;
  const binding = bindInProcessFabric({
    topic,
    intercept(event) {
      if (
        event.direction === "worker-to-hypervisor" &&
        typeof event.frame === "string" &&
        JSON.parse(event.frame).type === "work.start"
      ) {
        startsDropped++;
        queueMicrotask(() => binding.close("injected_start_loss"));
        return "drop";
      }
    },
    accept(connection) {
      void (async () => {
        const wire = await createProtocolTransport({
          connection: await createFrameConnection(connection),
          role: "hypervisor",
        });
        const iterator = wire.messages()[Symbol.asyncIterator]();
        const next = async (): Promise<ControlFrame> => {
          const item = await iterator.next();
          assert.ok(!item.done && item.value.kind === "control");
          return item.value.acceptance.frame;
        };
        const hello = await next();
        assert.equal(hello.type, "hello");
        const connectionId = crypto.randomUUID();
        await wire.sendControl(
          createWelcomeFrame({
            connectionId,
            heartbeatIntervalMs: 1000,
            leaseTimeoutMs: 5000,
            resumeCapability: "test-resume",
            resumeExpiresAtMs: Date.now() + 60_000,
            bootstrap: withHostCallCapacity({}, 2),
          }),
        );
        assert.equal((await next()).type, "ready");
        await wire.sendControl(createReadyAckFrame({ connectionId }));
        handshake.resolve();
        for await (const item of { [Symbol.asyncIterator]: () => iterator }) {
          if (item.kind !== "control") continue;
          const frame = item.acceptance.frame;
          if (frame.type === "work.open") {
            opens++;
            await wire.sendControl(
              createWorkAcceptedFrame({ streamId: frame.streamId }),
            );
          }
          if (frame.type === "work.start") startsReceived++;
        }
      })().catch(handshake.reject);
    },
  });
  const worker = createWorker({
    id: "start-loss",
    transport: { type: "in-process", config: { topic } },
    hostCalls: { timeoutMs: 500 },
    workloads: { unused: () => undefined },
    reconnectDelay: false,
    activate: () => ({
      workerId: "start-loss",
      attemptId: "test-attempt",
      epoch: 1,
    }),
    register: () => ({
      credential: { kind: "registration", capability: "test-registration" },
      expiresAtMs: Date.now() + 60_000,
    }),
  });
  try {
    await Promise.all([worker.ready, handshake.promise]);
    const call = await worker.callHost({ workload: "command" });
    await assert.rejects(
      call.completed,
      (error) => isHostCallError(error) && error.execution === "indeterminate",
    );
    assert.equal(startsDropped, 1);
    assert.equal(startsReceived, 0);
    assert.equal(opens, 1);
  } finally {
    binding.close();
    await worker.stop();
  }
});

test("in-process: reverse calls respect stricter local credit and data admission limits", {
  timeout: 5000,
}, async () => {
  const transport = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const hypervisor = createHypervisor({
    transports: [transport],
    config: {
      maxDataPayloadBytes: 128,
      maxReceiveCreditBytes: 64,
      shutdownTimeoutMs: 100,
    },
    workerCalls: {
      admit: () => undefined,
      admitUnassigned:
        () =>
        ({ input }) =>
          input,
    },
  });
  const worker = createWorker({
    id: "small-credit",
    transport,
    hostCalls: {},
    workloads: { unused: () => undefined },
  });
  try {
    await worker.ready;
    const body = new Uint8Array(4097).fill(42);
    const call = await worker.callHost({ workload: "echo", body });
    assert.deepEqual(
      new Uint8Array(await new Response(call.output).arrayBuffer()),
      body,
    );
    await call.completed;
  } finally {
    await worker.stop();
    await hypervisor.shutdown();
  }
});
