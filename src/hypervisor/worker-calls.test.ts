import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connectControlledWorker,
  type ControlledWorker,
  expectNoControlledMessage,
  nextControlledControl,
  nextControlledMessage,
} from "../../tests/hypervisor/controlled_worker.ts";
import { serve } from "../adapters/node/server.ts";
import {
  type ControlFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkEndFrame,
  createWorkMetadataFrame,
  createWorkOpenFrame,
  createWorkStartFrame,
  type JsonObject,
  withHostCallCapacity,
} from "../protocol/index.ts";
import type { WorkHandle } from "../work/types.ts";
import { createHypervisor } from "./hypervisor.ts";
import type { Hypervisor, WorkerCallOptions } from "./types.ts";

const TEST_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 2_000;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("controlled host-call test timed out")),
          STEP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(workerCalls: WorkerCallOptions) {
  const workers: ControlledWorker[] = [];
  const generations = new Map<string, number>();
  const hypervisor = createHypervisor({
    transports: [{ type: "websocket", config: { path: "/workers" } }],
    workerCalls: { timeoutMs: 5_000, ...workerCalls },
    config: { shutdownTimeoutMs: 100, cancellationAckTimeoutMs: 250 },
    admit: ({ identity, credential }) => {
      assert.equal(credential.capability, "controlled-test-only");
      const generation = (generations.get(identity.workerId) ?? 0) + 1;
      generations.set(identity.workerId, generation);
      return {
        definition: {
          workerId: identity.workerId,
          providerId: "controlled-test",
          workloads: ["action"],
          capacity: 1,
          providerConfig: {},
          labels: { owner: identity.workerId },
        },
        sessionGeneration: generation,
        authenticatedWith: credential.kind,
        resume: {
          credential: { kind: "resume", capability: "controlled-test-only" },
          expiresAtMs: Date.now() + 60_000,
        },
      };
    },
  });
  const listener = await serve({ hypervisor });
  const url = new URL("/workers", listener.url);
  url.protocol = "ws:";
  return {
    hypervisor,
    async connect(workerId = "worker-a", hostCallCapacity = 4) {
      const worker = await connectControlledWorker({
        url,
        identity: { workerId, attemptId: `${workerId}-attempt`, epoch: 7 },
        credential: {
          kind: "registration",
          capability: "controlled-test-only",
        },
        handshakeId: crypto.randomUUID(),
        workloads: ["action"],
        capacity: 1,
        readyMetadata: withHostCallCapacity({}, hostCallCapacity),
      });
      workers.push(worker);
      return worker;
    },
    async close() {
      try {
        await bounded(Promise.all(workers.map((worker) => worker.close())));
        await bounded(hypervisor.shutdown());
      } finally {
        await bounded(listener.shutdown());
      }
      assert.equal(hypervisor.snapshot().connections, 0);
    },
  };
}

// Body-less forward and reverse streams may receive credit before their next
// control frame. Keep one iterator consumer and reject every unexpected frame.
async function nextNonCredit(worker: ControlledWorker): Promise<ControlFrame> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "expected a non-credit frame before the deadline");
    const message = await nextControlledMessage(worker, remaining);
    assert.equal(message.kind, "control");
    if (message.kind !== "control") throw new Error("unexpected work data");
    const frame = message.acceptance.frame;
    if (frame.type !== "work.credit") return frame;
  }
}

async function offerParent(
  hypervisor: Hypervisor,
  worker: ControlledWorker,
  workerId = "worker-a",
): Promise<WorkHandle> {
  const parent = await bounded(
    hypervisor.dispatch({
      workload: "action",
      target: { workerId },
      metadata: { owner: workerId },
      deadlineAtMs: Date.now() + 5_000,
    }),
  );
  const open = await nextControlledControl(worker, "work.open");
  assert.equal(open.streamId, parent.streamId);
  return parent;
}

async function acceptParent(worker: ControlledWorker, parent: WorkHandle) {
  await worker.transport.sendControl(
    createWorkAcceptedFrame({ streamId: parent.streamId }),
  );
  const start = await nextControlledControl(worker, "work.start");
  assert.equal(start.streamId, parent.streamId);
  await bounded(parent.started);
  const end = await nextNonCredit(worker);
  assert.equal(end.type, "work.end");
  assert.ok("streamId" in end);
  assert.equal(end.streamId, parent.streamId);
}

async function startParent(
  hypervisor: Hypervisor,
  worker: ControlledWorker,
  workerId = "worker-a",
) {
  const parent = await offerParent(hypervisor, worker, workerId);
  await acceptParent(worker, parent);
  return parent;
}

async function completeParent(worker: ControlledWorker, parent: WorkHandle) {
  await worker.transport.sendControl(
    createWorkMetadataFrame({ streamId: parent.streamId, metadata: {} }),
  );
  await worker.transport.sendControl(
    createWorkEndFrame({ streamId: parent.streamId }),
  );
  assert.equal((await bounded(parent.completed)).status, "completed");
}

async function openCall(
  worker: ControlledWorker,
  parentStreamId: string,
  metadata: JsonObject = {},
) {
  const streamId = crypto.randomUUID();
  await worker.transport.sendControl(
    createWorkOpenFrame({
      streamId,
      parentStreamId,
      workload: "host.control",
      metadata,
      deadlineAtMs: Date.now() + 5_000,
    }),
  );
  return streamId;
}

async function expectRefused(worker: ControlledWorker, streamId: string) {
  const frame = await nextNonCredit(worker);
  assert.equal(frame.type, "work.error");
  if (frame.type !== "work.error") throw new Error("expected call refusal");
  assert.equal(frame.streamId, streamId);
  assert.equal(frame.code, "refused");
  await worker.transport.sendControl(
    createWorkCancelFrame({ streamId, reason: "refusal_ack" }),
  );
}

async function completeCall(worker: ControlledWorker, parentStreamId: string) {
  const streamId = await openCall(worker, parentStreamId);
  const accepted = await nextControlledControl(worker, "work.accepted");
  assert.equal(accepted.streamId, streamId);
  await worker.transport.sendControl(createWorkStartFrame({ streamId }));
  await worker.transport.sendControl(createWorkEndFrame({ streamId }));
  const metadata = await nextNonCredit(worker);
  assert.equal(metadata.type, "work.metadata");
  assert.ok("streamId" in metadata);
  assert.equal(metadata.streamId, streamId);
  const end = await nextNonCredit(worker);
  assert.equal(end.type, "work.end");
  assert.ok("streamId" in end);
  assert.equal(end.streamId, streamId);
}

test("websocket host calls: unknown parents never reach host admission", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  let admissions = 0;
  let starts = 0;
  const f = await fixture({
    admit: () => {
      admissions++;
      return () => {
        starts++;
      };
    },
  });
  try {
    const worker = await f.connect();
    await expectRefused(worker, await openCall(worker, crypto.randomUUID()));
    assert.equal(admissions, 0);
    assert.equal(starts, 0);
    const parent = await startParent(f.hypervisor, worker);
    await completeCall(worker, parent.streamId);
    assert.equal(admissions, 1);
    assert.equal(starts, 1);
    await completeParent(worker, parent);
  } finally {
    await f.close();
  }
});

test("websocket host calls: an offered but unstarted parent cannot authorize admission", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  let admissions = 0;
  const f = await fixture({
    admit: () => {
      admissions++;
      return () => undefined;
    },
  });
  try {
    const worker = await f.connect();
    const parent = await offerParent(f.hypervisor, worker);
    await expectRefused(worker, await openCall(worker, parent.streamId));
    assert.equal(admissions, 0);
    await acceptParent(worker, parent);
    await completeCall(worker, parent.streamId);
    assert.equal(admissions, 1);
    await completeParent(worker, parent);
  } finally {
    await f.close();
  }
});

test("websocket host calls: worker B cannot borrow worker A's started parent", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  let admissions = 0;
  let starts = 0;
  const f = await fixture({
    admit: (context) => {
      admissions++;
      assert.equal(context.fence.identity.workerId, "worker-a");
      assert.equal(context.parent?.metadata.owner, "worker-a");
      return () => {
        starts++;
      };
    },
  });
  try {
    const workerA = await f.connect("worker-a");
    const workerB = await f.connect("worker-b");
    const parent = await startParent(f.hypervisor, workerA);
    const forged = await openCall(workerB, parent.streamId, {
      workerId: "worker-a",
      owner: "worker-a",
      connectionId: workerA.welcome.connectionId,
      sessionGeneration: 1,
    });
    await expectRefused(workerB, forged);
    assert.equal(admissions, 0);
    assert.equal(starts, 0);
    await completeCall(workerA, parent.streamId);
    assert.equal(admissions, 1);
    assert.equal(starts, 1);
    await completeParent(workerA, parent);
  } finally {
    await f.close();
  }
});

test("websocket host calls: a replacement session cannot replay its old assignment", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  let admissions = 0;
  let starts = 0;
  const f = await fixture({
    admit: (context) => {
      admissions++;
      assert.equal(context.fence.sessionGeneration, 2);
      return () => {
        starts++;
      };
    },
  });
  try {
    const oldWorker = await f.connect();
    const oldParent = await startParent(f.hypervisor, oldWorker);
    const replacement = await f.connect();
    assert.notEqual(
      replacement.welcome.connectionId,
      oldWorker.welcome.connectionId,
    );
    assert.equal((await bounded(oldParent.completed)).status, "indeterminate");
    const replay = await openCall(replacement, oldParent.streamId, {
      connectionId: oldWorker.welcome.connectionId,
      sessionGeneration: 1,
    });
    await expectRefused(replacement, replay);
    assert.equal(admissions, 0);
    assert.equal(starts, 0);
    const currentParent = await startParent(f.hypervisor, replacement);
    await completeCall(replacement, currentParent.streamId);
    assert.equal(admissions, 1);
    assert.equal(starts, 1);
    await completeParent(replacement, currentParent);
  } finally {
    await f.close();
  }
});

test("websocket host calls: losing a parent during async admission never starts its handler", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  let starts = 0;
  const f = await fixture({
    admit: async (context) => {
      entered.resolve(context.signal);
      await release.promise;
      returned.resolve();
      return () => {
        starts++;
      };
    },
  });
  try {
    const worker = await f.connect();
    const parent = await startParent(f.hypervisor, worker);
    const call = await openCall(worker, parent.streamId);
    const signal = await bounded(entered.promise);
    assert.equal(signal.aborted, false);
    await completeParent(worker, parent);
    assert.equal(signal.aborted, true);
    const cancelled = await nextNonCredit(worker);
    assert.equal(cancelled.type, "work.error");
    if (cancelled.type !== "work.error")
      throw new Error("expected call cancellation");
    assert.equal(cancelled.streamId, call);
    assert.equal(cancelled.code, "cancelled");
    await worker.transport.sendControl(
      createWorkCancelFrame({ streamId: call, reason: "parent_completed_ack" }),
    );
    release.resolve();
    await bounded(returned.promise);
    // This is the final read: a timed-out iterator read remains owned until close.
    await expectNoControlledMessage(worker, 50);
    assert.equal(starts, 0);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("websocket host calls: parent completion between acceptance and start prevents execution", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  let admissions = 0;
  let starts = 0;
  const f = await fixture({
    admit: () => {
      admissions++;
      return () => {
        starts++;
      };
    },
  });
  try {
    const worker = await f.connect();
    const parent = await startParent(f.hypervisor, worker);
    const call = await openCall(worker, parent.streamId);
    const accepted = await nextControlledControl(worker, "work.accepted");
    assert.equal(accepted.streamId, call);
    assert.equal(admissions, 1);
    assert.equal(starts, 0);
    await completeParent(worker, parent);
    // The worker has not read the cancellation yet. Its crossed start must not
    // resurrect authority lost after admission returned the handler.
    await worker.transport.sendControl(
      createWorkStartFrame({ streamId: call }),
    );
    const cancelled = await nextNonCredit(worker);
    assert.equal(cancelled.type, "work.error");
    if (cancelled.type !== "work.error")
      throw new Error("expected call cancellation");
    assert.equal(cancelled.streamId, call);
    assert.equal(cancelled.code, "cancelled");
    await worker.transport.sendControl(
      createWorkCancelFrame({ streamId: call, reason: "parent_completed_ack" }),
    );
    await expectNoControlledMessage(worker, 50);
    assert.equal(starts, 0);
  } finally {
    await f.close();
  }
});

test("websocket host calls: negotiated capacity includes cancelled unsettled handlers", {
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let admissions = 0;
  const f = await fixture({
    maxPerConnection: 4,
    admit: () => {
      admissions++;
      return async () => {
        entered.resolve();
        await release.promise;
      };
    },
  });
  try {
    const worker = await f.connect("worker-a", 1);
    const parent = await startParent(f.hypervisor, worker);
    const first = await openCall(worker, parent.streamId);
    await nextControlledControl(worker, "work.accepted");
    await worker.transport.sendControl(
      createWorkStartFrame({ streamId: first }),
    );
    await bounded(entered.promise);
    await worker.transport.sendControl(
      createWorkCancelFrame({ streamId: first, reason: "test" }),
    );
    const ack = await nextNonCredit(worker);
    assert.equal(ack.type, "work.error");
    await expectRefused(worker, await openCall(worker, parent.streamId));
    assert.equal(admissions, 1);
    release.resolve();
    await completeParent(worker, parent);
  } finally {
    release.resolve();
    await f.close();
  }
});
