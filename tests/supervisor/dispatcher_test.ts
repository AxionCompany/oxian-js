import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("claim does not authorize execution until durable acceptance commits", async () => {
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
  assertEquals(offered.status, "offered");
  const claimed = dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assertEquals(claimed.status, "claimed");
  assertEquals(persisted, false);

  const commitment = dispatcher.commitAcceptance(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );
  assertEquals(dispatcher.get(claimed.operationId)?.status, "committing");
  assertEquals(persisted, false);
  await Promise.resolve();
  assertEquals(accepted, {
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
  assertEquals(Object.isFrozen(accepted), true);
  assertEquals(Object.isFrozen(accepted?.metadata), true);
  assertEquals(
    Object.isFrozen(accepted?.metadata.nested as object),
    true,
  );
  releasePersistence();
  assertEquals((await commitment).status, "committed");
  assertEquals(persisted, true);

  const completed = dispatcher.complete(
    claimed.operationId,
    claimed.assignment!.fence,
    claimed.assignment!.streamId,
  );
  assertEquals(completed.status, "completed");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
});

Deno.test("disconnect before commit is explicitly reschedulable", () => {
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
  assertEquals(lost[0].status, "reschedulable");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  const retried = dispatcher.retry(offered.operationId);
  assertEquals(retried.status, "offered");
  assertEquals(retried.deliveryCount, 2);
  assertEquals(retried.assignment?.streamId, STREAM_IDS[1]);
});

Deno.test("exact target is immutable and survives rescheduling", async () => {
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
  assertEquals(offered.target, { workerId: "worker-b" });
  assertEquals(Object.isFrozen(offered.target), true);
  assertEquals(offered.assignment?.fence.identity.workerId, "worker-b");

  const [lost] = dispatcher.connectionLost(offered.assignment!.fence);
  assertEquals(lost.status, "reschedulable");
  assertEquals(lost.target, { workerId: "worker-b" });
  const retried = dispatcher.retry(offered.operationId);
  assertEquals(retried.deliveryCount, 2);
  assertEquals(retried.target, { workerId: "worker-b" });
  assertEquals(retried.assignment?.fence.identity.workerId, "worker-b");

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
  assertEquals(accepted?.target, { workerId: "worker-b" });
  dispatcher.complete(
    retried.operationId,
    retried.assignment!.fence,
    retried.assignment!.streamId,
  );
});

Deno.test("disconnect after commit is indeterminate and never retryable", async () => {
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
  assertEquals(lost.status, "indeterminate");
  assertEquals(lost.terminal?.code, "connection_lost_after_commit");
  assertThrows(
    () => dispatcher.retry(claimed.operationId),
    Error,
    "does not exist",
  );
});

Deno.test("pre-start cancellation remains reserved until worker acknowledgement", () => {
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
  assertEquals(cancelling.status, "cancelling");
  assertEquals(context.sessions.get("worker-1")?.reserved, 1);
  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assertEquals(cancelled.terminal?.code, "caller_cancelled");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
});

Deno.test("crossed Accepted after pre-claim cancellation is idempotent", () => {
  const context = createReadySession();
  const dispatcher = createWorkDispatcher({
    sessions: context.sessions,
    createWorkStreamId: () => STREAM_IDS[0],
    commitAcceptedWork: () => Promise.resolve(),
  });
  const offered = dispatcher.offer({ workload: "sandbox.command" });
  assertEquals(dispatcher.cancel(offered.operationId).status, "cancelling");
  const crossed = dispatcher.claim(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assertEquals(crossed.status, "cancelling");
  assertEquals(typeof crossed.claimedAtMs, "number");
  assertEquals(context.sessions.get("worker-1")?.reserved, 1);
  assertEquals(
    dispatcher.confirmCancellation(
      offered.operationId,
      offered.assignment!.fence,
      offered.assignment!.streamId,
    ).status,
    "cancelled",
  );
});

Deno.test("post-start cancellation remains reserved until worker acknowledgement", async () => {
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
  assertEquals(cancelling.status, "cancelling");
  assertEquals(context.sessions.get("worker-1")?.reserved, 1);

  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assertEquals(cancelled.status, "cancelled");
  assertEquals(cancelled.terminal?.code, "caller_cancelled");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
});

Deno.test("connection loss before cancellation acknowledgement is indeterminate", async () => {
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
  assertEquals(lost.status, "indeterminate");
  assertEquals(
    lost.terminal?.code,
    "connection_lost_during_cancellation",
  );
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  assertThrows(
    () => dispatcher.retry(offered.operationId),
    Error,
    "does not exist",
  );
});

Deno.test("crossed result settles work that was awaiting cancellation acknowledgement", async () => {
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
  assertEquals(completed.status, "completed");

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
  assertEquals(failed.status, "failed");
  assertEquals(failed.terminal?.code, "worker_failed");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
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

Deno.test("loss during durable commit becomes indeterminate only after persistence succeeds", async () => {
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
  assertEquals(changed[0].status, "committing");
  assertThrows(
    () => dispatcher.retry(offered.operationId),
    Error,
    "acceptance commit in flight",
  );
  resolvePersistence();
  const result = await commitment;
  assertEquals(result.status, "indeterminate");
  assertEquals(result.terminal?.code, "connection_lost_before_start");
});

Deno.test("replacement fencing rejects frames from the displaced socket", () => {
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
  assertEquals(
    dispatcher.connectionLost(staleFence)[0].status,
    "reschedulable",
  );
});

Deno.test("assignment matching includes worker, attempt, epoch, connection, and stream", () => {
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

Deno.test("peer terminal safely reschedules offered and claimed streams", () => {
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
  assertEquals(rejected.status, "reschedulable");

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
  assertEquals(cancelled.status, "reschedulable");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  assertEquals(dispatcher.list().length, 2);
});

Deno.test("peer rejection crossing acceptance persistence suppresses commit", async () => {
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
  assertEquals(crossed.status, "committing");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  persistence.resolve();
  assertEquals((await commitment).status, "indeterminate");
  assertEquals(dispatcher.list().length, 0);
});

Deno.test("ambiguous persistence stays indeterminate until stream cancellation closes", async () => {
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
  assertEquals(result.status, "indeterminate");
  assertEquals(result.terminal?.code, "acceptance_persistence_unknown");
  assertEquals(context.sessions.get("worker-1")?.reserved, 1);
  assertEquals(dispatcher.list().length, 1);

  const acknowledged = dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "cancel", reason: "pre-start cancelled" },
  );
  assertEquals(acknowledged.status, "indeterminate");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  assertEquals(dispatcher.list().length, 0);
});

Deno.test("synchronous persistence throw is deferred and cannot strand commit bookkeeping", async () => {
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
  assertEquals(dispatcher.get(offered.operationId)?.status, "committing");
  assertEquals((await commitment).status, "indeterminate");
  dispatcher.settlePeerTerminal(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
    { type: "cancel", reason: "cancelled after ambiguous failure" },
  );
  assertEquals(dispatcher.list().length, 0);
});

Deno.test("cancellation may cross an in-flight acceptance commit", async () => {
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
  assertEquals(dispatcher.cancel(offered.operationId).status, "cancelling");
  assertEquals(context.sessions.get("worker-1")?.reserved, 1);
  persistence.resolve();
  const committedCancellation = await commitment;
  assertEquals(committedCancellation.status, "cancelling");
  assertEquals(
    typeof committedCancellation.committedAtMs,
    "number",
  );
  const cancelled = dispatcher.confirmCancellation(
    offered.operationId,
    offered.assignment!.fence,
    offered.assignment!.streamId,
  );
  assertEquals(cancelled.status, "cancelled");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  assertEquals(dispatcher.list().length, 0);
});

Deno.test("completed operations are evicted from process-local dispatcher memory", async () => {
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

  assertEquals(dispatcher.list().length, 0);
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
});

Deno.test("a definitely undelivered offer can be withdrawn without a worker acknowledgement", () => {
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

  assertEquals(withdrawn.status, "cancelled");
  assertEquals(withdrawn.assignment, undefined);
  assertEquals(withdrawn.terminal?.code, "owner_route_failed");
  assertEquals(context.sessions.get("worker-1")?.reserved, 0);
  assertEquals(dispatcher.get(offered.operationId), undefined);
});

Deno.test("a surfaced reschedulable result can be explicitly evicted but an active offer cannot", () => {
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
  assertEquals(reschedulable.status, "reschedulable");
  assertEquals(dispatcher.discard(offered.operationId), reschedulable);
  assertEquals(dispatcher.get(offered.operationId), undefined);
});
