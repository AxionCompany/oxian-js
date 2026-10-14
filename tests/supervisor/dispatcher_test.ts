import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import {
  type AcceptanceCommit,
  createWorkDispatcher,
} from "../../src/supervisor/dispatcher.ts";
import {
  createSessionRegistry,
  fenceForSession,
} from "../../src/supervisor/sessions.ts";
import type { SessionFence } from "../../src/supervisor/types.ts";

const IDENTITY = {
  workerId: "worker-1",
  attemptId: "attempt-1",
  epoch: 1,
} as const;

const STREAM_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

function createReadySession() {
  let nowMs = 10;
  const sessions = createSessionRegistry({ clock: () => nowMs });
  const session = sessions.attach({
    identity: IDENTITY,
    connectionId: "connection-1",
    sessionGeneration: 1,
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 1_000,
  }).session;
  sessions.markReady(fenceForSession(session));
  return {
    sessions,
    fence: fenceForSession(session),
    tick() {
      nowMs++;
    },
  };
}

function attachReadyWorker(
  sessions: ReturnType<typeof createSessionRegistry>,
  workerId: string,
) {
  const session = sessions.attach({
    identity: {
      workerId,
      attemptId: `attempt-${workerId}`,
      epoch: 1,
    },
    connectionId: `connection-${workerId}`,
    sessionGeneration: 1,
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 1_000,
  }).session;
  return sessions.markReady(fenceForSession(session));
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

function streamId(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

test("claim does not authorize execution until durable acceptance commits", async () => {
  const context = createReadySession();
  let streamIndex = 0;
  let releasePersistence!: () => void;
  let persisted = false;
  let accepted: AcceptanceCommit | undefined;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = () => {
      persisted = true;
      resolve();
    };
  });
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[streamIndex++],
    commitAcceptedWork: (commit) => {
      accepted = commit;
      return persistence;
    },
  });
  const deadlineAtMs = Date.now() + 60_000;

  const offered = dispatcher.offer({
    workload: "sandbox.command",
    metadata: {
      ownerOperationId: "tool-execution-1",
      nested: { immutable: true },
    },
    deadlineAtMs,
  });
  assert.deepStrictEqual(offered.status, "offered");
  const claimed = dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(claimed.status, "claimed");
  assert.deepStrictEqual(persisted, false);

  const commitment = dispatcher.commitAcceptance(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );
  assert.deepStrictEqual(
    dispatcher.get(claimed.operationId)?.status,
    "committing",
  );
  assert.deepStrictEqual(persisted, false);
  await Promise.resolve();
  assert.deepStrictEqual(accepted, {
    operationId: offered.operationId,
    workload: "sandbox.command",
    metadata: {
      ownerOperationId: "tool-execution-1",
      nested: { immutable: true },
    },
    deadlineAtMs,
    deliveryCount: 1,
    assignment: offered.assignment!,
    claimedAtMs: claimed.claimedAtMs!,
  });
  assert.deepStrictEqual(Object.isFrozen(accepted), true);
  assert.deepStrictEqual(Object.isFrozen(accepted?.metadata), true);
  assert.deepStrictEqual(
    Object.isFrozen(accepted?.metadata.nested as object),
    true,
  );
  releasePersistence();
  assert.deepStrictEqual((await commitment).status, "committed");
  assert.deepStrictEqual(persisted, true);

  const completed = dispatcher.complete(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );
  assert.deepStrictEqual(completed.status, "completed");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
});

test("disconnect before commit is explicitly reschedulable", () => {
  const context = createReadySession();
  let streamIndex = 0;
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[streamIndex++],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );

  const lost = dispatcher.connectionLost(offered.assignment!.fence);
  assert.deepStrictEqual(lost[0].status, "reschedulable");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  const retried = dispatcher.retry(offered.operationId);
  assert.deepStrictEqual(retried.status, "offered");
  assert.deepStrictEqual(retried.deliveryCount, 2);
  assert.deepStrictEqual(retried.assignment?.streamId, STREAM_IDS[1]);
});

test("exact target is immutable and survives rescheduling", async () => {
  const sessions = createSessionRegistry({ clock: () => 10 });
  attachReadyWorker(sessions, "worker-a");
  attachReadyWorker(sessions, "worker-b");
  let streamIndex = 0;
  let accepted: AcceptanceCommit | undefined;
  const dispatcher = createWorkDispatcher({
    sessions,
    createWorkStreamId: () => STREAM_IDS[streamIndex++],
    commitAcceptedWork: (commit) => {
      accepted = commit;
      return Promise.resolve();
    },
  });
  const target = { workerId: "worker-b" };

  const offered = dispatcher.offer({
    workload: "sandbox.command",
    target,
  });
  target.workerId = "worker-a";
  assert.deepStrictEqual(offered.target, { workerId: "worker-b" });
  assert.deepStrictEqual(Object.isFrozen(offered.target), true);
  assert.deepStrictEqual(
    offered.assignment?.fence.identity.workerId,
    "worker-b",
  );

  const [lost] = dispatcher.connectionLost(offered.assignment!.fence);
  assert.deepStrictEqual(lost.status, "reschedulable");
  assert.deepStrictEqual(lost.target, { workerId: "worker-b" });
  const retried = dispatcher.retry(offered.operationId);
  assert.deepStrictEqual(retried.deliveryCount, 2);
  assert.deepStrictEqual(retried.target, { workerId: "worker-b" });
  assert.deepStrictEqual(
    retried.assignment?.fence.identity.workerId,
    "worker-b",
  );

  dispatcher.claim(
    retried.operationId,
    retried.assignment!.fence,
    retried.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    retried.operationId,
    retried.assignment!.fence,
    retried.assignment!.streamId,
  );
  assert.deepStrictEqual(accepted?.target, { workerId: "worker-b" });
  dispatcher.complete(
    retried.operationId,
    retried.assignment!.fence,
    retried.assignment!.streamId,
  );
});

test("disconnect after commit is indeterminate and never retryable", async () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  const claimed = dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );

  const [lost] = dispatcher.connectionLost(claimed.assignment!.fence);
  assert.deepStrictEqual(lost.status, "indeterminate");
  assert.deepStrictEqual(lost.terminal?.code, "connection_lost_after_commit");
  assertThrows(
    () => dispatcher.retry(claimed.operationId),
    Error,
    "does not exist",
  );
});

test("pre-start cancellation remains reserved until worker acknowledgement", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );

  const cancelling = dispatcher.cancel(offered.operationId, {
    code: "caller_cancelled",
    message: "request disconnected",
  });
  assert.deepStrictEqual(cancelling.status, "cancelling");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 1);
  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(cancelled.terminal?.code, "caller_cancelled");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
});

test("crossed Accepted after pre-claim cancellation is idempotent", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  assert.deepStrictEqual(
    dispatcher.cancel(offered.operationId).status,
    "cancelling",
  );
  const crossed = dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(crossed.status, "cancelling");
  assert.deepStrictEqual(typeof crossed.claimedAtMs, "number");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 1);
  assert.deepStrictEqual(
    dispatcher.confirmCancellation(
      offered.operationId,
      offered.assignment!.fence,
      offered.assignment!.streamId,
    ).status,
    "cancelled",
  );
});

test("post-start cancellation remains reserved until worker acknowledgement", async () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );

  const cancelling = dispatcher.cancel(offered.operationId, {
    code: "caller_cancelled",
  });
  assert.deepStrictEqual(cancelling.status, "cancelling");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 1);

  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(cancelled.status, "cancelled");
  assert.deepStrictEqual(cancelled.terminal?.code, "caller_cancelled");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
});

test("connection loss before cancellation acknowledgement is indeterminate", async () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  dispatcher.cancel(offered.operationId);

  const [lost] = dispatcher.connectionLost(offered.assignment!.fence);
  assert.deepStrictEqual(lost.status, "indeterminate");
  assert.deepStrictEqual(
    lost.terminal?.code,
    "connection_lost_during_cancellation",
  );
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assertThrows(
    () => dispatcher.retry(offered.operationId),
    Error,
    "does not exist",
  );
});

test("crossed result settles work that was awaiting cancellation acknowledgement", async () => {
  const context = createReadySession();
  let streamIndex = 0;
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[streamIndex++],
    commitAcceptedWork: () => Promise.resolve(),
  });

  const first = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    first.operationId,
    first.assignment!.fence,
    first.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    first.operationId,
    first.assignment!.fence,
    first.assignment!.streamId,
  );
  dispatcher.cancel(first.operationId);
  const completed = dispatcher.complete(
    first.operationId,
    first.assignment!.fence,
    first.assignment!.streamId,
  );
  assert.deepStrictEqual(completed.status, "completed");

  const second = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    second.operationId,
    second.assignment!.fence,
    second.assignment!.streamId,
  );
  await dispatcher.commitAcceptance(
    second.operationId,
    second.assignment!.fence,
    second.assignment!.streamId,
  );
  dispatcher.cancel(second.operationId);
  const failed = dispatcher.fail(
    second.operationId,
    second.assignment!.fence,
    second.assignment!.streamId,
    { code: "worker_failed", message: "failed before cancellation" },
  );
  assert.deepStrictEqual(failed.status, "failed");
  assert.deepStrictEqual(failed.terminal?.code, "worker_failed");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assertThrows(
    () =>
      dispatcher.confirmCancellation(
        second.operationId,
        second.assignment!.fence,
        second.assignment!.streamId,
      ),
    Error,
    "does not exist",
  );
});

test("loss during durable commit becomes indeterminate only after persistence succeeds", async () => {
  const context = createReadySession();
  let resolvePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    resolvePersistence = resolve;
  });
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => persistence,
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const commitment = dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );

  const changed = dispatcher.connectionLost(offered.assignment!.fence);
  assert.deepStrictEqual(changed[0].status, "committing");
  assertThrows(
    () => dispatcher.retry(offered.operationId),
    Error,
    "acceptance commit in flight",
  );
  resolvePersistence();
  const result = await commitment;
  assert.deepStrictEqual(result.status, "indeterminate");
  assert.deepStrictEqual(result.terminal?.code, "connection_lost_before_start");
});

test("replacement fencing rejects frames from the displaced socket", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  const staleFence = offered.assignment!.fence;

  const replacement = context.sessions.attach({
    identity: IDENTITY,
    connectionId: "connection-2",
    sessionGeneration: 2,
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 1_000,
  }).session;
  context.sessions.markReady(fenceForSession(replacement));

  assertThrows(
    () =>
      dispatcher.claim(
        offered.operationId,
        staleFence,
        offered.assignment!.streamId,
      ),
    Error,
    "not current",
  );
  assert.deepStrictEqual(
    dispatcher.connectionLost(staleFence)[0].status,
    "reschedulable",
  );
});

test("assignment matching includes worker, attempt, epoch, connection, and stream", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  const wrongFence: SessionFence = {
    identity: { ...IDENTITY, epoch: 2 },
    connectionId: offered.assignment!.fence.connectionId,
    sessionGeneration: offered.assignment!.fence.sessionGeneration,
  };

  assertThrows(
    () =>
      dispatcher.claim(
        offered.operationId,
        wrongFence,
        offered.assignment!.streamId,
      ),
    Error,
    "not current",
  );
});

test("peer terminal safely reschedules offered and claimed streams", () => {
  const context = createReadySession();
  let sequence = 0;
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(++sequence),
    commitAcceptedWork: () => Promise.resolve(),
  });

  const offered = dispatcher.offer({ workload: "sandbox.command" });
  const rejected = dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "error", code: "busy", message: "worker rejected offer" },
  );
  assert.deepStrictEqual(rejected.status, "reschedulable");

  const claimed = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );
  const cancelled = dispatcher.settlePeerTerminal(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
    { type: "cancel", reason: "worker declined" },
  );
  assert.deepStrictEqual(cancelled.status, "reschedulable");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assert.deepStrictEqual(dispatcher.list().length, 2);
});

test("peer rejection crossing acceptance persistence suppresses commit", async () => {
  const context = createReadySession();
  const persistence = createDeferred<void>();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(1),
    commitAcceptedWork: () => persistence.promise,
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const commitment = dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const crossed = dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "error", code: "rejected", message: "cannot execute" },
  );
  assert.deepStrictEqual(crossed.status, "committing");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  persistence.resolve();
  assert.deepStrictEqual((await commitment).status, "indeterminate");
  assert.deepStrictEqual(dispatcher.list().length, 0);
});

test("ambiguous persistence stays indeterminate until stream cancellation closes", async () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(1),
    commitAcceptedWork: () => Promise.reject(new Error("ack lost")),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const result = await dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(result.status, "indeterminate");
  assert.deepStrictEqual(
    result.terminal?.code,
    "acceptance_persistence_unknown",
  );
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 1);
  assert.deepStrictEqual(dispatcher.list().length, 1);

  const acknowledged = dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "cancel", reason: "pre-start cancelled" },
  );
  assert.deepStrictEqual(acknowledged.status, "indeterminate");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assert.deepStrictEqual(dispatcher.list().length, 0);
});

test("synchronous persistence throw is deferred and cannot strand commit bookkeeping", async () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(1),
    commitAcceptedWork: () => {
      throw new Error("synchronous adapter failure");
    },
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const commitment = dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(
    dispatcher.get(offered.operationId)?.status,
    "committing",
  );
  assert.deepStrictEqual((await commitment).status, "indeterminate");
  dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "cancel", reason: "cancelled after ambiguous failure" },
  );
  assert.deepStrictEqual(dispatcher.list().length, 0);
});

test("cancellation may cross an in-flight acceptance commit", async () => {
  const context = createReadySession();
  const persistence = createDeferred<void>();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(1),
    commitAcceptedWork: () => persistence.promise,
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  const commitment = dispatcher.commitAcceptance(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(
    dispatcher.cancel(offered.operationId).status,
    "cancelling",
  );
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 1);
  persistence.resolve();
  const committedCancellation = await commitment;
  assert.deepStrictEqual(committedCancellation.status, "cancelling");
  assert.deepStrictEqual(
    typeof committedCancellation.committedAtMs,
    "number",
  );
  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assert.deepStrictEqual(cancelled.status, "cancelled");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assert.deepStrictEqual(dispatcher.list().length, 0);
});

test("completed operations are evicted from process-local dispatcher memory", async () => {
  const context = createReadySession();
  let sequence = 0;
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => streamId(++sequence),
    commitAcceptedWork: () => Promise.resolve(),
  });

  for (let index = 0; index < 100; index++) {
    const offered = dispatcher.offer({ workload: "sandbox.command" });
    dispatcher.claim(
      offered.operationId,
      offered.assignment!.fence,
      offered.assignment!.streamId,
    );
    await dispatcher.commitAcceptance(
      offered.operationId,
      offered.assignment!.fence,
      offered.assignment!.streamId,
    );
    dispatcher.complete(
      offered.operationId,
      offered.assignment!.fence,
      offered.assignment!.streamId,
    );
  }

  assert.deepStrictEqual(dispatcher.list().length, 0);
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
});

test("a definitely undelivered offer can be withdrawn without a worker acknowledgement", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });

  const withdrawn = dispatcher.withdrawOffer(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    {
      code: "owner_route_failed",
      message: "WorkOpen was never delivered",
    },
  );

  assert.deepStrictEqual(withdrawn.status, "cancelled");
  assert.deepStrictEqual(withdrawn.assignment, undefined);
  assert.deepStrictEqual(withdrawn.terminal?.code, "owner_route_failed");
  assert.deepStrictEqual(context.sessions.get("worker-1")?.reserved, 0);
  assert.deepStrictEqual(dispatcher.get(offered.operationId), undefined);
});

test("a surfaced reschedulable result can be explicitly evicted but an active offer cannot", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  assertThrows(
    () => dispatcher.discard(offered.operationId),
    Error,
    "cannot discard",
  );

  const [reschedulable] = dispatcher.connectionLost(
    offered.assignment!.fence,
  );
  assert.deepStrictEqual(reschedulable.status, "reschedulable");
  assert.deepStrictEqual(
    dispatcher.discard(offered.operationId),
    reschedulable,
  );
  assert.deepStrictEqual(dispatcher.get(offered.operationId), undefined);
});
