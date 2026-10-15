import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects } from "../support/assert.ts";
import { serve } from "../../src/adapters/node/index.ts";
import type {
  Hypervisor,
  HypervisorConfig,
  HypervisorListener,
  HypervisorScheduler,
} from "../../src/hypervisor/index.ts";
import {
  createProtocolTestHypervisor as createHypervisor,
  TEST_WORKER_PATH,
} from "./protocol_hypervisor.ts";
import type { WorkHandle } from "../../src/work/index.ts";
import {
  createDrainedFrame,
  createHeartbeatFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkDataFrame,
  createWorkEndFrame,
  createWorkMetadataFrame,
  WORKER_PROTOCOL_LIMITS,
  type WorkerCredential,
  type WorkerIdentity,
} from "../../src/protocol/index.ts";
import type { AcceptanceCommit } from "../../src/supervisor/index.ts";
import {
  createEphemeralCredentialLifecycle,
  createEphemeralWorkerStore,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";
import {
  connectControlledWorker,
  type ControlledWorker,
  expectNoControlledMessage,
  nextControlledControl,
  nextControlledMessage,
} from "./controlled_worker.ts";

const TEST_TIMEOUT_MS = 5_000;
const encoder = new TextEncoder();

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

type ControlledHarness = Readonly<{
  hypervisor: Hypervisor;
  listener: HypervisorListener;
  identity: WorkerIdentity;
  worker: ControlledWorker;
  connect(
    credential: WorkerCredential,
    handshakeId: string,
  ): Promise<ControlledWorker>;
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

function websocketUrl(listener: HypervisorListener, path: string): URL {
  const url = new URL(path, listener.url);
  url.protocol = "ws:";
  return url;
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function observeSettlement<T>(
  promise: Promise<T>,
): Readonly<{ settled(): boolean }> {
  let value = false;
  promise.then(
    () => {
      value = true;
    },
    () => {
      value = true;
    },
  );
  return Object.freeze({ settled: () => value });
}

async function expectRejectedHandle(handle: WorkHandle) {
  await assertRejects(() => handle.started, Error);
  await assertRejects(() => handle.metadata, Error);
  await assertRejects(() => readAll(handle.output), Error);
}

async function receiveRequestEnd(
  worker: ControlledWorker,
  streamId: string,
): Promise<number> {
  let responseCredit = 0;
  while (true) {
    const message = await nextControlledMessage(worker);
    if (message.kind !== "control") {
      throw new TypeError(
        `unexpected request data for body-less stream ${streamId}`,
      );
    }
    const frame = message.acceptance.frame;
    if (frame.type === "work.credit") {
      assert.deepStrictEqual(frame.streamId, streamId);
      responseCredit += frame.bytes;
      continue;
    }
    if (frame.type === "work.end") {
      assert.deepStrictEqual(frame.streamId, streamId);
      return responseCredit;
    }
    throw new TypeError(`unexpected frame ${frame.type}`);
  }
}

async function startControlledHarness(
  input: Readonly<{
    commitAcceptedWork(commit: AcceptanceCommit): Promise<void>;
    capacity?: number;
    config?: Partial<HypervisorConfig>;
    scheduler?: HypervisorScheduler;
    clock?: () => number;
    createConnectionId?: () => string;
  }>,
): Promise<ControlledHarness> {
  const capacity = input.capacity ?? 4;
  const repository = createEphemeralWorkerStore();
  await repository.define(
    createWorkerDefinition({
      workerId: "controlled-worker",
      providerId: "attached",
      workloads: ["sandbox.command"],
      capacity,
    }),
  );
  const identity = (await repository.activate("controlled-worker")).attempt
    .identity;
  const authority = createEphemeralCredentialLifecycle();
  const registration = await authority.issueRegistration(identity);
  const hypervisor = createHypervisor({
    control: { authority, repository },
    commitAcceptedWork: input.commitAcceptedWork,
    ...(input.scheduler === undefined ? {} : { scheduler: input.scheduler }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.createConnectionId === undefined
      ? {}
      : { createConnectionId: input.createConnectionId }),
    config: {
      heartbeatIntervalMs: 100,
      leaseTimeoutMs: 2_000,
      leaseSweepIntervalMs: 50,
      shutdownTimeoutMs: 100,
      cancellationAckTimeoutMs: 250,
      maxConnectionAgeMs: 60_000,
      proactiveDrainMarginMs: 1_000,
      ...input.config,
    },
  });
  const listener = await serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const url = websocketUrl(listener, TEST_WORKER_PATH);
  const workers = new Set<ControlledWorker>();
  let handshakeSequence = 0;

  const connect = async (
    credential: WorkerCredential,
    handshakeId = `controlled-handshake-${++handshakeSequence}`,
  ): Promise<ControlledWorker> => {
    const worker = await connectControlledWorker({
      url,
      identity,
      credential,
      handshakeId,
      workloads: ["sandbox.command"],
      capacity,
    });
    workers.add(worker);
    await waitFor(
      () =>
        hypervisor.sessions.get(identity.workerId)?.connectionId ===
          worker.welcome.connectionId &&
        hypervisor.sessions.get(identity.workerId)?.phase === "ready",
      "controlled worker did not become routable",
    );
    return worker;
  };

  let worker: ControlledWorker;
  try {
    worker = await connect(
      registration.credential,
      "controlled-registration-handshake",
    );
  } catch (error) {
    await hypervisor.shutdown("controlled_setup_failed").catch(() => undefined);
    await listener.shutdown().catch(() => undefined);
    throw error;
  }

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closed !== undefined) return closed;
    closed = (async () => {
      await Promise.all(
        [...workers].map((candidate) =>
          candidate.close("controlled_test_cleanup"),
        ),
      );
      await hypervisor
        .shutdown("controlled_test_cleanup")
        .catch(() => undefined);
      await listener.shutdown().catch(() => undefined);
    })();
    return closed;
  };
  return Object.freeze({
    hypervisor,
    listener,
    identity,
    worker,
    connect,
    close,
  });
}

test("request chunk that exactly consumes credit still discovers EOF and sends work.end", async () => {
  const request = encoder.encode("exact-credit-request");
  let pulls = 0;
  let emitted = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        if (!emitted) {
          emitted = true;
          controller.enqueue(request);
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
        body,
      }),
    );
    const open = await nextControlledControl(harness.worker, "work.open");
    assert.deepStrictEqual(open.streamId, handle.streamId);
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await harness.worker.transport.sendControl(
      createWorkCreditFrame({
        streamId: handle.streamId,
        bytes: request.byteLength,
      }),
    );

    let data: Uint8Array | undefined;
    let ended = false;
    while (!ended) {
      const message = await nextControlledMessage(harness.worker);
      if (message.kind === "data") {
        assert.deepStrictEqual(
          message.acceptance.frame.streamId,
          handle.streamId,
        );
        data = message.acceptance.frame.payload;
        continue;
      }
      const frame = message.acceptance.frame;
      if (frame.type === "work.credit") continue;
      if (frame.type === "work.end") {
        assert.deepStrictEqual(frame.streamId, handle.streamId);
        ended = true;
        continue;
      }
      throw new TypeError(`unexpected frame ${frame.type}`);
    }
    assert.deepStrictEqual(data, request);
    assert.deepStrictEqual(pulls, 2);

    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: handle.streamId,
        metadata: {},
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: handle.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(handle.metadata), {});
    assert.deepStrictEqual(
      await withTimeout(readAll(handle.output)),
      new Uint8Array(),
    );
    assert.deepStrictEqual(
      (await withTimeout(handle.completed)).status,
      "completed",
    );
  } finally {
    await harness.close();
  }
});

test("persistence rejection waits for peer cancellation acknowledgement before completion", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () =>
      Promise.reject(new Error("commit outcome unavailable")),
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    const cancellation = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(
      cancellation.reason,
      "acceptance_persistence_unknown",
    );

    const completion = observeSettlement(handle.completed);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(completion.settled(), false);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      1,
    );

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: handle.streamId,
        reason: "cancellation_acknowledged",
      }),
    );
    assert.deepStrictEqual(
      (await withTimeout(handle.completed)).status,
      "indeterminate",
    );
    await expectRejectedHandle(handle);
    await waitFor(
      () =>
        harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved ===
        0,
      "cancellation acknowledgement did not release the reservation",
    );
    assert.deepStrictEqual(
      Object.values(harness.hypervisor.snapshot().work).every(
        (count) => count === 0,
      ),
      true,
    );
  } finally {
    await harness.close();
  }
});

test("caller cancellation before Accepted tolerates crossed Accepted without Start", async () => {
  let persistenceCalls = 0;
  const harness = await startControlledHarness({
    commitAcceptedWork: () => {
      persistenceCalls++;
      return Promise.resolve();
    },
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");

    const cancellation = handle.cancel("cancelled_before_accepted");
    // Send Accepted without first reading the Hypervisor's Cancel. The two
    // frames cross on the wire, exercising the explicit pre-Start race.
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    const cancelFrame = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(cancelFrame.streamId, handle.streamId);
    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: handle.streamId,
        reason: "cancelled_before_accepted_ack",
      }),
    );

    assert.deepStrictEqual(
      (await withTimeout(cancellation)).status,
      "cancelled",
    );
    assert.deepStrictEqual(persistenceCalls, 0);
    await expectRejectedHandle(handle);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
  } finally {
    await harness.close();
  }
});

test("acceptance persistence admission cap reschedules one stream without disturbing the admitted commit", async () => {
  const persistEntered = createDeferred<void>();
  const releasePersistence = createDeferred<void>();
  let persistenceCalls = 0;
  const harness = await startControlledHarness({
    commitAcceptedWork: async () => {
      persistenceCalls++;
      persistEntered.resolve();
      await releasePersistence.promise;
    },
    config: {
      maxPendingAcceptanceCommits: 1,
      maxPendingAcceptanceCommitsPerWorker: 1,
    },
  });

  try {
    const admitted = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: admitted.streamId }),
    );
    await withTimeout(persistEntered.promise);
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      1,
    );

    const rejected = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: rejected.streamId }),
    );
    const capacityCancel = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(capacityCancel.streamId, rejected.streamId);
    assert.deepStrictEqual(capacityCancel.reason, "acceptance_commit_capacity");
    const rejectionCompletion = observeSettlement(rejected.completed);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(rejectionCompletion.settled(), false);
    assert.deepStrictEqual(persistenceCalls, 1);

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: rejected.streamId,
        reason: "acceptance_commit_capacity_ack",
      }),
    );
    assert.deepStrictEqual(
      (await withTimeout(rejected.completed)).status,
      "reschedulable",
    );
    await expectRejectedHandle(rejected);
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      1,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    releasePersistence.resolve();
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, admitted.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: admitted.streamId,
        metadata: { admitted: true },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: admitted.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(admitted.metadata), {
      admitted: true,
    });
    assert.deepStrictEqual(
      (await withTimeout(admitted.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      0,
    );
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
  } finally {
    releasePersistence.resolve();
    await harness.close();
  }
});

test("socket loss during gated persistence settles only after the durable outcome", async () => {
  const persistEntered = createDeferred<void>();
  const releasePersistence = createDeferred<void>();
  const harness = await startControlledHarness({
    commitAcceptedWork: async () => {
      persistEntered.resolve();
      await releasePersistence.promise;
    },
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await withTimeout(persistEntered.promise);
    const completion = observeSettlement(handle.completed);
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      1,
    );
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommitsByWorker,
      [{ workerId: harness.identity.workerId, count: 1 }],
    );

    await harness.worker.close("loss_during_acceptance_commit");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(completion.settled(), false);
    releasePersistence.resolve();

    const result = await withTimeout(handle.completed);
    assert.deepStrictEqual(result.status, "indeterminate");
    assert.deepStrictEqual(
      result.terminal?.code,
      "connection_lost_before_start",
    );
    await expectRejectedHandle(handle);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId),
      undefined,
    );
    assert.deepStrictEqual(
      Object.values(harness.hypervisor.snapshot().work).every(
        (count) => count === 0,
      ),
      true,
    );
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      0,
    );
  } finally {
    releasePersistence.resolve();
    await harness.close();
  }
});

test("peer terminal during gated persistence becomes indeterminate without pending leak", async () => {
  const persistEntered = createDeferred<void>();
  const releasePersistence = createDeferred<void>();
  const harness = await startControlledHarness({
    commitAcceptedWork: async () => {
      persistEntered.resolve();
      await releasePersistence.promise;
    },
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await withTimeout(persistEntered.promise);
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      1,
    );

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: handle.streamId,
        reason: "worker_rejected_before_start",
      }),
    );
    await nextControlledControl(harness.worker, "work.cancel");
    const completion = observeSettlement(handle.completed);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(completion.settled(), false);

    releasePersistence.resolve();
    const result = await withTimeout(handle.completed);
    assert.deepStrictEqual(result.status, "indeterminate");
    assert.deepStrictEqual(result.terminal?.code, "accepted_worker_rejection");
    await expectRejectedHandle(handle);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    assert.deepStrictEqual(
      Object.values(harness.hypervisor.snapshot().work).every(
        (count) => count === 0,
      ),
      true,
    );
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().pendingAcceptanceCommits,
      0,
    );
  } finally {
    releasePersistence.resolve();
    await harness.close();
  }
});

test("connection loss before Accepted is reschedulable", async () => {
  let persistenceCalls = 0;
  const harness = await startControlledHarness({
    commitAcceptedWork: () => {
      persistenceCalls++;
      return Promise.resolve();
    },
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.close("loss_before_accepted");

    const result = await withTimeout(handle.completed);
    assert.deepStrictEqual(result.status, "reschedulable");
    assert.deepStrictEqual(result.deliveryCount, 1);
    assert.deepStrictEqual(persistenceCalls, 0);
    await expectRejectedHandle(handle);
    // The caller receives the immutable rescheduling decision; the
    // Hypervisor does not retain an in-process retry queue.
    assert.deepStrictEqual(harness.hypervisor.snapshot().work.reschedulable, 0);
  } finally {
    await harness.close();
  }
});

test("connection loss after Start is indeterminate and never replayed", async () => {
  let persistenceCalls = 0;
  const harness = await startControlledHarness({
    commitAcceptedWork: () => {
      persistenceCalls++;
      return Promise.resolve();
    },
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await withTimeout(handle.started);
    await harness.worker.close("loss_after_start");

    const result = await withTimeout(handle.completed);
    assert.deepStrictEqual(result.status, "indeterminate");
    assert.deepStrictEqual(
      result.terminal?.code,
      "connection_lost_after_commit",
    );
    assert.deepStrictEqual(persistenceCalls, 1);
    await assertRejects(() => handle.metadata, Error);
    await assertRejects(() => readAll(handle.output), Error);

    const replacement = await harness.connect(
      {
        kind: "resume",
        capability: harness.worker.welcome.resumeCapability,
      },
      "replacement-handshake",
    );
    await expectNoControlledMessage(replacement, 75);
    assert.deepStrictEqual(
      Object.values(harness.hypervisor.snapshot().work).every(
        (count) => count === 0,
      ),
      true,
    );
  } finally {
    await harness.close();
  }
});

test("worker draining before Accepted rejects as reschedulable and releases its reservation", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    const drain = harness.hypervisor.drain(
      harness.identity.workerId,
      "preaccept_rotation",
    );
    await nextControlledControl(harness.worker, "drain");
    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: handle.streamId,
        reason: "worker_draining",
      }),
    );
    await nextControlledControl(harness.worker, "work.cancel");

    const result = await withTimeout(handle.completed);
    assert.deepStrictEqual(result.status, "reschedulable");
    await expectRejectedHandle(handle);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    await harness.worker.transport.sendControl(
      createDrainedFrame({
        connectionId: harness.worker.welcome.connectionId,
      }),
    );
    await withTimeout(drain);
    assert.deepStrictEqual(harness.hypervisor.snapshot().work.reschedulable, 0);
  } finally {
    await harness.close();
  }
});

test("output cancellation upgrades a sent request End and leaves concurrent work healthy", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const cancelledHandle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: cancelledHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, cancelledHandle.streamId);

    const cancelledReader = cancelledHandle.output.getReader();
    const cancellation = cancelledReader.cancel("response_consumer_left");
    const cancelFrame = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(cancelFrame.streamId, cancelledHandle.streamId);
    const cancellationCompletion = observeSettlement(cancelledHandle.completed);

    // Keep the cancellation unacknowledged while another operation executes
    // to prove the stream-local End->Cancel upgrade does not close the
    // multiplexed worker socket.
    const healthyHandle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    const healthyOpen = await nextControlledControl(
      harness.worker,
      "work.open",
    );
    assert.deepStrictEqual(healthyOpen.streamId, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: healthyHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: healthyHandle.streamId,
        metadata: { result: "healthy" },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: healthyHandle.streamId,
      }),
    );

    assert.deepStrictEqual(await withTimeout(healthyHandle.metadata), {
      result: "healthy",
    });
    assert.deepStrictEqual(
      await withTimeout(readAll(healthyHandle.output)),
      new Uint8Array(),
    );
    assert.deepStrictEqual(
      (await withTimeout(healthyHandle.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(cancellationCompletion.settled(), false);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: cancelledHandle.streamId,
        reason: "response_consumer_left_ack",
      }),
    );
    await withTimeout(cancellation);
    assert.deepStrictEqual(
      (await withTimeout(cancelledHandle.completed)).status,
      "cancelled",
    );
    await assertRejects(() => cancelledHandle.metadata, Error);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
  } finally {
    await harness.close();
  }
});

test("crossed worker End after Hypervisor Cancel settles only after worker abort upgrade", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const crossed = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: crossed.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, crossed.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: crossed.streamId,
        metadata: { crossed: "normal_end" },
      }),
    );
    assert.deepStrictEqual(await withTimeout(crossed.metadata), {
      crossed: "normal_end",
    });

    // Observe the response stream before cancellation so its expected
    // terminal error cannot surface as an unhandled stream rejection.
    const crossedOutputFailure = assertRejects(
      () => readAll(crossed.output),
      Error,
    );
    const cancellation = crossed.cancel("caller_cancelled");
    // Send the normal response End without first reading the Hypervisor's
    // Cancel. It therefore crosses the peer abort on the wire.
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: crossed.streamId,
      }),
    );
    const peerCancel = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(peerCancel.streamId, crossed.streamId);
    const completion = observeSettlement(crossed.completed);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(completion.settled(), false);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      1,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().work.cancelling, 1);

    const healthy = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: healthy.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, healthy.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: healthy.streamId,
        metadata: { healthy: true },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: healthy.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(healthy.metadata), {
      healthy: true,
    });
    assert.deepStrictEqual(
      (await withTimeout(healthy.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(completion.settled(), false);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    // Upgrade the worker's already-sent End to Cancel after observing the
    // peer abort. Only this closes the cancellation handshake.
    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: crossed.streamId,
        reason: "caller_cancelled_ack",
      }),
    );
    assert.deepStrictEqual(
      (await withTimeout(cancellation)).status,
      "cancelled",
    );
    assert.deepStrictEqual(
      (await withTimeout(crossed.completed)).status,
      "cancelled",
    );
    await crossedOutputFailure;
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
  } finally {
    await harness.close();
  }
});

test("oversized streamed request chunk cancels only that stream and keeps multiplexed work healthy", async () => {
  let pulled = false;
  const oversized = new Uint8Array(
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes + 1,
  ).fill(0x7b);
  const oversizedBody = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled) {
          controller.close();
          return;
        }
        pulled = true;
        controller.enqueue(oversized);
      },
    },
    { highWaterMark: 0 },
  );
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const oversizedHandle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
        body: oversizedBody,
      }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: oversizedHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await harness.worker.transport.sendControl(
      createWorkCreditFrame({
        streamId: oversizedHandle.streamId,
        bytes: oversized.byteLength,
      }),
    );

    let cancellationSeen = false;
    while (!cancellationSeen) {
      const message = await nextControlledMessage(harness.worker);
      if (message.kind === "data") {
        throw new TypeError(
          "oversized source chunk was partially emitted instead of rejected",
        );
      }
      const frame = message.acceptance.frame;
      if (frame.type === "work.credit") continue;
      if (frame.type === "work.cancel") {
        assert.deepStrictEqual(frame.streamId, oversizedHandle.streamId);
        cancellationSeen = true;
        continue;
      }
      throw new TypeError(`unexpected frame ${frame.type}`);
    }
    assert.deepStrictEqual(pulled, true);

    const healthyHandle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    const healthyOpen = await nextControlledControl(
      harness.worker,
      "work.open",
    );
    assert.deepStrictEqual(healthyOpen.streamId, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: healthyHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: healthyHandle.streamId,
        metadata: { isolated: true },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: healthyHandle.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(healthyHandle.metadata), {
      isolated: true,
    });
    assert.deepStrictEqual(
      (await withTimeout(healthyHandle.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: oversizedHandle.streamId,
        reason: "oversized_chunk_ack",
      }),
    );
    assert.deepStrictEqual(
      (await withTimeout(oversizedHandle.completed)).status,
      "cancelled",
    );
    await withTimeout(oversizedHandle.started);
    await assertRejects(() => oversizedHandle.metadata, Error);
    await assertRejects(() => readAll(oversizedHandle.output), Error);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
  } finally {
    await harness.close();
  }
});

test("queued response data racing output cancellation is discarded without tearing down the socket", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const racedHandle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: racedHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    const responseCredit = await receiveRequestEnd(
      harness.worker,
      racedHandle.streamId,
    );
    assert.deepStrictEqual(responseCredit > 0, true);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: racedHandle.streamId,
        metadata: { response: "started" },
      }),
    );
    assert.deepStrictEqual(await withTimeout(racedHandle.metadata), {
      response: "started",
    });

    const chunkBytes = Math.min(1_024, responseCredit);
    const chunkCount = Math.min(64, Math.floor(responseCredit / chunkBytes));
    const sends = Array.from({ length: chunkCount }, (_, sequence) =>
      harness.worker.transport.sendData(
        createWorkDataFrame({
          streamId: racedHandle.streamId,
          sequence,
          payload: new Uint8Array(chunkBytes).fill(sequence),
        }),
      ),
    );
    const racedReader = racedHandle.output.getReader();
    const cancellation = racedReader.cancel("queued_data_consumer_left");
    await Promise.allSettled(sends);

    let cancelSeen = false;
    while (!cancelSeen) {
      const message = await nextControlledMessage(harness.worker);
      if (message.kind !== "control") {
        throw new TypeError("Hypervisor sent unexpected response data");
      }
      const frame = message.acceptance.frame;
      if (frame.type === "work.credit") continue;
      if (frame.type === "work.cancel") {
        assert.deepStrictEqual(frame.streamId, racedHandle.streamId);
        cancelSeen = true;
        continue;
      }
      throw new TypeError(`unexpected frame ${frame.type}`);
    }
    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: racedHandle.streamId,
        reason: "queued_data_consumer_left_ack",
      }),
    );
    await withTimeout(cancellation);
    assert.deepStrictEqual(
      (await withTimeout(racedHandle.completed)).status,
      "cancelled",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    const healthyHandle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    const healthyOpen = await nextControlledControl(
      harness.worker,
      "work.open",
    );
    assert.deepStrictEqual(healthyOpen.streamId, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: healthyHandle.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, healthyHandle.streamId);
    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: healthyHandle.streamId,
        metadata: { afterRace: "healthy" },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: healthyHandle.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(healthyHandle.metadata), {
      afterRace: "healthy",
    });
    assert.deepStrictEqual(
      (await withTimeout(healthyHandle.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
  } finally {
    await harness.close();
  }
});

test("pre-aborted dispatch emits no work frame and leaves the worker routable", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });
  const abort = new AbortController();
  abort.abort(new DOMException("already_gone", "AbortError"));

  try {
    await assertRejects(
      () =>
        harness.hypervisor.dispatch({
          workload: "sandbox.command",
          signal: abort.signal,
        }),
      DOMException,
      "already_gone",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
    await expectNoControlledMessage(harness.worker, 50);
  } finally {
    await harness.close();
  }
});

test("caller abort racing direct dispatch sends Open then stream-local Cancel and preserves concurrent work", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const survivor = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    await nextControlledControl(harness.worker, "work.open");
    await harness.worker.transport.sendControl(
      createWorkAcceptedFrame({ streamId: survivor.streamId }),
    );
    await nextControlledControl(harness.worker, "work.start");
    await receiveRequestEnd(harness.worker, survivor.streamId);

    const abort = new AbortController();
    const victimPromise = harness.hypervisor.dispatch({
      workload: "sandbox.command",
      signal: abort.signal,
    });
    // dispatch() has crossed its initial pre-abort check. Direct session
    // routing must finish the single WorkOpen delivery, then bind this
    // already-fired cancellation to that handle.
    abort.abort(new DOMException("caller_left", "AbortError"));
    const victim = await withTimeout(victimPromise);

    // Even though the peer has not read WorkOpen yet, the wire order must
    // remain Open then Cancel.
    const victimOpen = await nextControlledControl(harness.worker, "work.open");
    assert.deepStrictEqual(victimOpen.streamId, victim.streamId);
    const victimCancel = await nextControlledControl(
      harness.worker,
      "work.cancel",
    );
    assert.deepStrictEqual(victimCancel.streamId, victim.streamId);

    await harness.worker.transport.sendControl(
      createWorkMetadataFrame({
        streamId: survivor.streamId,
        metadata: { survivor: true },
      }),
    );
    await harness.worker.transport.sendControl(
      createWorkEndFrame({
        streamId: survivor.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(survivor.metadata), {
      survivor: true,
    });
    assert.deepStrictEqual(
      (await withTimeout(survivor.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    await harness.worker.transport.sendControl(
      createWorkCancelFrame({
        streamId: victim.streamId,
        reason: "caller_left_ack",
      }),
    );
    assert.deepStrictEqual(
      (await withTimeout(victim.completed)).status,
      "cancelled",
    );
    await expectRejectedHandle(victim);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.reserved,
      0,
    );
  } finally {
    await harness.close();
  }
});

test("post-Open deadline scheduler failure returns one handle and settles through connection loss", async () => {
  let rejectScheduling = false;
  const scheduler: HypervisorScheduler = Object.freeze({
    schedule(callback, delayMs) {
      if (rejectScheduling) {
        throw new Error("injected post-ready scheduler failure");
      }
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
    scheduler,
  });

  try {
    rejectScheduling = true;
    const handle = await withTimeout(
      harness.hypervisor.dispatch({
        workload: "sandbox.command",
        deadlineAtMs: Date.now() + 1_000,
      }),
    );

    assert.deepStrictEqual(
      (await withTimeout(handle.completed)).status,
      "reschedulable",
    );
    await expectRejectedHandle(handle);
    await waitFor(
      () => harness.hypervisor.snapshot().connections === 0,
      "post-Open setup failure did not close its connection",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().sessions, 0);
    assert.deepStrictEqual(
      Object.values(harness.hypervisor.snapshot().work).every(
        (count) => count === 0,
      ),
      true,
    );
    await assertRejects(
      () =>
        harness.hypervisor.dispatch({
          workload: "sandbox.command",
        }),
      Error,
      "no ready Worker has capacity",
    );
  } finally {
    await harness.close();
  }
});

test("replacement session fences stale socket frames and remains routable", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const replacement = await harness.connect(
      {
        kind: "resume",
        capability: harness.worker.welcome.resumeCapability,
      },
      "newer-session-handshake",
    );
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.connectionId,
      replacement.welcome.connectionId,
    );

    // If the replacement close has not reached the old socket yet, this
    // stale heartbeat reaches the Hypervisor and must fail its current
    // session fence. If closure won the race, sendControl rejects locally.
    await harness.worker.transport
      .sendControl(
        createHeartbeatFrame({
          connectionId: harness.worker.welcome.connectionId,
          sequence: 0,
          inflight: 0,
          availableCapacity: 4,
        }),
      )
      .catch(() => undefined);
    await withTimeout(harness.worker.transport.closed);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.connectionId,
      replacement.welcome.connectionId,
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);

    const handle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    const open = await nextControlledControl(replacement, "work.open");
    assert.deepStrictEqual(open.streamId, handle.streamId);
    await replacement.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await nextControlledControl(replacement, "work.start");
    await receiveRequestEnd(replacement, handle.streamId);
    await replacement.transport.sendControl(
      createWorkMetadataFrame({
        streamId: handle.streamId,
        metadata: { owner: "replacement" },
      }),
    );
    await replacement.transport.sendControl(
      createWorkEndFrame({
        streamId: handle.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(handle.metadata), {
      owner: "replacement",
    });
    assert.deepStrictEqual(
      (await withTimeout(handle.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
  } finally {
    await harness.close();
  }
});

test("expired lease event cannot close a newer generation reusing its connection ID", async () => {
  type HeldSweep = {
    callback: () => void;
    cancelled: boolean;
  };
  const heldSweeps: HeldSweep[] = [];
  const heldHandles = new Set<HeldSweep>();
  const leaseSweepIntervalMs = 333;
  const scheduler: HypervisorScheduler = Object.freeze({
    schedule(callback, delayMs) {
      if (delayMs === leaseSweepIntervalMs) {
        const held = { callback, cancelled: false };
        heldSweeps.push(held);
        heldHandles.add(held);
        return held;
      }
      return setTimeout(callback, delayMs);
    },
    cancel(handle) {
      const held = handle as HeldSweep;
      if (heldHandles.has(held)) {
        held.cancelled = true;
        heldHandles.delete(held);
        return;
      }
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  const runNextSweep = (): void => {
    while (true) {
      const held = heldSweeps.shift();
      if (held === undefined) {
        throw new TypeError("expected a held lease sweep");
      }
      heldHandles.delete(held);
      if (held.cancelled) continue;
      held.callback();
      return;
    }
  };
  let nowMs = 1_000;
  const reusedConnectionId = "reused-connection";
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
    scheduler,
    clock: () => nowMs,
    createConnectionId: () => reusedConnectionId,
    config: { leaseSweepIntervalMs },
  });

  try {
    const firstSession = harness.hypervisor.sessions.get(
      harness.identity.workerId,
    )!;
    assert.deepStrictEqual(firstSession.sessionGeneration, 1);
    nowMs = firstSession.leaseExpiresAtMs;
    // A public read expires generation 1 and queues its lifecycle event, but
    // the intentionally held Hypervisor sweep has not consumed it yet.
    assert.deepStrictEqual(harness.hypervisor.sessions.list(), []);
    await harness.worker.close("expired_generation_closed");
    await waitFor(
      () => harness.hypervisor.snapshot().connections === 0,
      "expired generation socket did not close",
    );

    const replacement = await harness.connect(
      {
        kind: "resume",
        capability: harness.worker.welcome.resumeCapability,
      },
      "reused-connection-generation-2",
    );
    assert.deepStrictEqual(
      replacement.welcome.connectionId,
      reusedConnectionId,
    );
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)
        ?.sessionGeneration,
      2,
    );

    // Draining generation 1's queued event must compare the complete fence,
    // not resolve generation 2 through the reused connection ID.
    runNextSweep();
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
    assert.deepStrictEqual(
      harness.hypervisor.sessions.get(harness.identity.workerId)?.connectionId,
      reusedConnectionId,
    );

    const handle = await withTimeout(
      harness.hypervisor.dispatch({ workload: "sandbox.command" }),
    );
    const open = await nextControlledControl(replacement, "work.open");
    assert.deepStrictEqual(open.streamId, handle.streamId);
    await replacement.transport.sendControl(
      createWorkAcceptedFrame({ streamId: handle.streamId }),
    );
    await nextControlledControl(replacement, "work.start");
    await receiveRequestEnd(replacement, handle.streamId);
    await replacement.transport.sendControl(
      createWorkMetadataFrame({
        streamId: handle.streamId,
        metadata: { generation: 2 },
      }),
    );
    await replacement.transport.sendControl(
      createWorkEndFrame({
        streamId: handle.streamId,
      }),
    );
    assert.deepStrictEqual(await withTimeout(handle.metadata), {
      generation: 2,
    });
    assert.deepStrictEqual(
      (await withTimeout(handle.completed)).status,
      "completed",
    );
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 1);
  } finally {
    await harness.close();
  }
});

test("terminal shutdown remains open until the worker acknowledges its ordered Shutdown", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
  });

  try {
    const shutdown = harness.hypervisor.shutdownWorker(
      harness.identity.workerId,
      "acknowledged_shutdown",
    );
    const settlement = observeSettlement(shutdown);
    await nextControlledControl(harness.worker, "drain");
    await harness.worker.transport.sendControl(
      createDrainedFrame({
        connectionId: harness.worker.welcome.connectionId,
      }),
    );
    const terminal = await nextControlledControl(harness.worker, "shutdown");
    assert.deepStrictEqual(terminal.reason, "drain_complete");
    await Promise.resolve();
    assert.deepStrictEqual(settlement.settled(), false);

    await harness.worker.close("shutdown_acknowledged");
    await withTimeout(shutdown);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 0);
    assert.deepStrictEqual(harness.hypervisor.snapshot().sessions, 0);
  } finally {
    await harness.close();
  }
});

test("terminal shutdown waits for drain deadline before Shutdown when worker does not acknowledge", async () => {
  const harness = await startControlledHarness({
    commitAcceptedWork: () => Promise.resolve(),
    config: { shutdownTimeoutMs: 80 },
  });

  try {
    const shutdown = harness.hypervisor.shutdown("deadline_shutdown");
    const settlement = observeSettlement(shutdown);
    const drain = await nextControlledControl(harness.worker, "drain");
    assert.deepStrictEqual(drain.reason, "deadline_shutdown");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepStrictEqual(settlement.settled(), false);

    const terminal = await nextControlledControl(harness.worker, "shutdown");
    assert.deepStrictEqual(
      terminal.connectionId,
      harness.worker.welcome.connectionId,
    );
    await withTimeout(shutdown);
    await withTimeout(harness.worker.transport.closed);
    assert.deepStrictEqual(harness.hypervisor.snapshot().connections, 0);
    assert.deepStrictEqual(
      harness.hypervisor.snapshot().acceptingConnections,
      false,
    );
  } finally {
    await harness.close();
  }
});
