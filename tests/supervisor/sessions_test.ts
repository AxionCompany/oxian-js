import { assertEquals, assertThrows } from "@std/assert";
import {
  createSessionRegistry,
  fenceForSession,
} from "../../src/supervisor/sessions.ts";
import type { SupervisorError } from "../../src/supervisor/types.ts";

const IDENTITY = {
  workerId: "worker-1",
  attemptId: "attempt-1",
  epoch: 1,
} as const;

function attach(
  registry: ReturnType<typeof createSessionRegistry>,
  connectionId = "connection-1",
  sessionGeneration = 1,
) {
  return registry.attach({
    identity: IDENTITY,
    connectionId,
    sessionGeneration,
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 100,
  }).session;
}

function attachReadyWorker(
  registry: ReturnType<typeof createSessionRegistry>,
  workerId: string,
  input: Readonly<{
    workloads?: readonly string[];
    capacity?: number;
  }> = {},
) {
  const session = registry.attach({
    identity: {
      workerId,
      attemptId: `attempt-${workerId}`,
      epoch: 1,
    },
    connectionId: `connection-${workerId}`,
    sessionGeneration: 1,
    workloads: input.workloads ?? ["sandbox.command"],
    capacity: input.capacity ?? 2,
    leaseTimeoutMs: 100,
  }).session;
  return registry.markReady(fenceForSession(session));
}

Deno.test("session replacement fences every operation on the stale connection", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  const first = attach(registry);
  const oldLease = registry.lease(fenceForSession(first));
  const replacement = attach(registry, "connection-2", 2);

  assertEquals(registry.isCurrent(fenceForSession(first)), false);
  assertEquals(oldLease.isCurrent(), false);
  const error = assertThrows(() => oldLease.assertCurrent()) as SupervisorError;
  assertEquals(error.code, "stale_session");
  assertEquals(
    registry.assertCurrent(fenceForSession(replacement)).connectionId,
    "connection-2",
  );
  assertEquals(registry.detach(fenceForSession(first)), undefined);
  assertEquals(registry.get("worker-1")?.connectionId, "connection-2");
});

Deno.test("equal generation replay cannot displace a live session", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  const first = attach(registry);

  const error = assertThrows(
    () => attach(registry, "connection-2", 1),
  ) as SupervisorError;
  assertEquals(error.code, "stale_session");
  assertEquals(registry.get("worker-1")?.connectionId, first.connectionId);
});

Deno.test("reused connection ID cannot revive an older generation fence", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  const first = attach(registry);
  const oldLease = registry.lease(fenceForSession(first));
  registry.detach(fenceForSession(first));

  const replacement = attach(registry, first.connectionId, 2);
  registry.markReady(fenceForSession(replacement));
  assertEquals(oldLease.isCurrent(), false);
  const error = assertThrows(() => oldLease.assertCurrent()) as SupervisorError;
  assertEquals(error.code, "stale_session");
  assertEquals(registry.isCurrent(fenceForSession(replacement)), true);
});

Deno.test("session generation high-watermark survives detach and expiry", () => {
  let nowMs = 0;
  const registry = createSessionRegistry({ clock: () => nowMs });
  const first = attach(registry, "connection-1", 2);
  registry.detach(fenceForSession(first));

  const detachedStale = assertThrows(
    () => attach(registry, "connection-stale", 1),
  ) as SupervisorError;
  assertEquals(detachedStale.code, "stale_session");
  const detachedReplay = assertThrows(
    () => attach(registry, "connection-detached-replay", 2),
  ) as SupervisorError;
  assertEquals(detachedReplay.code, "stale_session");

  const next = attach(registry, "connection-next", 3);
  nowMs = next.leaseExpiresAtMs;
  registry.expireLeases();
  const expiredStale = assertThrows(
    () => attach(registry, "connection-expired-stale", 3),
  ) as SupervisorError;
  assertEquals(expiredStale.code, "stale_session");
  assertEquals(
    attach(registry, "connection-after-expiry", 4).sessionGeneration,
    4,
  );
});

Deno.test("session heartbeat extends the lease and expiry removes readiness", () => {
  let nowMs = 0;
  const registry = createSessionRegistry({ clock: () => nowMs });
  const session = attach(registry);
  const fence = fenceForSession(session);
  registry.markReady(fence);

  nowMs = 50;
  const heartbeat = registry.heartbeat(fence, { sequence: 0 });
  assertEquals(heartbeat.leaseExpiresAtMs, 150);
  nowMs = 149;
  assertEquals(registry.get("worker-1")?.phase, "ready");
  nowMs = 150;
  assertEquals(registry.expireLeases()[0].phase, "expired");
  assertEquals(registry.get("worker-1"), undefined);
});

Deno.test("in-process sessions retain readiness across an overdue heartbeat sweep", () => {
  let nowMs = 0;
  const registry = createSessionRegistry({ clock: () => nowMs });
  const session = registry.attach({
    identity: IDENTITY,
    connectionId: "in-process-connection",
    sessionGeneration: 1,
    transportType: "in-process",
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 100,
  }).session;
  const fence = fenceForSession(session);
  registry.markReady(fence);

  nowMs = 10_000;
  assertEquals(registry.expireLeases(), []);
  assertEquals(registry.assertCurrent(fence).phase, "ready");
});

Deno.test("connected sessions use the Ready deadline and start their lease when published", () => {
  let nowMs = 0;
  const registry = createSessionRegistry({ clock: () => nowMs });
  const connected = attach(registry);
  const fence = fenceForSession(connected);

  nowMs = 1_000;
  assertEquals(registry.expireLeases(), []);
  assertEquals(registry.get("worker-1")?.phase, "connected");

  const ready = registry.markReady(fence);
  assertEquals(ready.lastHeartbeatAtMs, 1_000);
  assertEquals(ready.leaseExpiresAtMs, 1_100);

  nowMs = 1_099;
  assertEquals(registry.expireLeases(), []);
  nowMs = 1_100;
  assertEquals(registry.expireLeases()[0]?.phase, "expired");
});

Deno.test("read and admission observers cannot consume lease-expiry events", () => {
  for (
    const observe of [
      (registry: ReturnType<typeof createSessionRegistry>) => registry.list(),
      (registry: ReturnType<typeof createSessionRegistry>) =>
        registry.get("worker-1"),
      (registry: ReturnType<typeof createSessionRegistry>) => {
        assertThrows(() => registry.reserve({ workload: "sandbox.command" }));
      },
    ]
  ) {
    let nowMs = 0;
    const registry = createSessionRegistry({ clock: () => nowMs });
    const session = attach(registry);
    registry.markReady(fenceForSession(session));
    nowMs = session.leaseExpiresAtMs;

    observe(registry);
    const expired = registry.expireLeases();
    assertEquals(expired.length, 1);
    assertEquals(expired[0].connectionId, session.connectionId);
    assertEquals(expired[0].phase, "expired");
    assertEquals(registry.expireLeases(), []);
  }
});

Deno.test("newer generation attachment reports an expired predecessor", () => {
  let nowMs = 0;
  const registry = createSessionRegistry({ clock: () => nowMs });
  const connected = attach(registry);
  const first = registry.markReady(fenceForSession(connected));
  nowMs = first.leaseExpiresAtMs;

  const attachment = registry.attach({
    identity: IDENTITY,
    connectionId: "connection-2",
    sessionGeneration: 2,
    workloads: ["sandbox.command"],
    capacity: 2,
    leaseTimeoutMs: 100,
  });
  assertEquals(attachment.replaced?.connectionId, first.connectionId);
  assertEquals(attachment.replaced?.phase, "expired");
  assertEquals(registry.get("worker-1")?.connectionId, "connection-2");
});

Deno.test("draining stops admission and waits for reserved work", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  const session = attach(registry);
  const fence = fenceForSession(session);
  registry.markReady(fence);
  registry.reserve({ workload: "sandbox.command" });
  registry.reserve({ workload: "sandbox.command" });
  assertEquals(registry.startDrain(fence).phase, "draining");

  const exhausted = assertThrows(
    () => registry.reserve({ workload: "sandbox.command" }),
  ) as SupervisorError;
  assertEquals(exhausted.code, "capacity_exhausted");
  assertThrows(
    () => registry.markDrained(fence),
    Error,
    "reserved work",
  );

  registry.release(fence);
  registry.release(fence);
  assertEquals(registry.markDrained(fence).phase, "drained");
});

Deno.test("explicit reservation targets one exact ready worker", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  attachReadyWorker(registry, "worker-a");
  attachReadyWorker(registry, "worker-b");

  const targeted = registry.reserve({
    workload: "sandbox.command",
    target: { workerId: "worker-b" },
  });
  assertEquals(targeted.identity.workerId, "worker-b");
  assertEquals(registry.get("worker-a")?.reserved, 0);
  assertEquals(registry.get("worker-b")?.reserved, 1);
});

Deno.test("targeted reservation never spills to another eligible worker", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  const workerA = attachReadyWorker(registry, "worker-a", {
    capacity: 1,
  });
  const workerB = attachReadyWorker(registry, "worker-b", {
    workloads: ["sandbox.command", "sandbox.other"],
    capacity: 2,
  });

  registry.reserve({
    workload: "sandbox.command",
    target: { workerId: "worker-a" },
  });
  for (
    const input of [
      {
        workload: "sandbox.command",
        target: { workerId: "worker-a" },
      },
      {
        workload: "sandbox.command",
        target: { workerId: "worker-missing" },
      },
      {
        workload: "sandbox.other",
        target: { workerId: "worker-a" },
      },
    ] as const
  ) {
    const error = assertThrows(() =>
      registry.reserve(input)
    ) as SupervisorError;
    assertEquals(error.code, "capacity_exhausted");
  }

  registry.startDrain(fenceForSession(workerB));
  const draining = assertThrows(() =>
    registry.reserve({
      workload: "sandbox.command",
      target: { workerId: "worker-b" },
    })
  ) as SupervisorError;
  assertEquals(draining.code, "capacity_exhausted");
  assertEquals(registry.get("worker-a")?.reserved, 1);
  assertEquals(registry.get("worker-b")?.reserved, 0);
  registry.release(fenceForSession(workerA));
});

Deno.test("untargeted reservation retains least-load balancing", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  attachReadyWorker(registry, "worker-a");
  attachReadyWorker(registry, "worker-b");

  assertEquals(
    registry.reserve({ workload: "sandbox.command" }).identity.workerId,
    "worker-a",
  );
  assertEquals(
    registry.reserve({ workload: "sandbox.command" }).identity.workerId,
    "worker-b",
  );
  assertEquals(registry.get("worker-a")?.reserved, 1);
  assertEquals(registry.get("worker-b")?.reserved, 1);
});

Deno.test("lower epochs and conflicting attempts cannot replace a session", () => {
  const registry = createSessionRegistry({ clock: () => 10 });
  attach(registry);

  const stale = assertThrows(() =>
    registry.attach({
      identity: {
        workerId: "worker-1",
        attemptId: "attempt-old",
        epoch: 0,
      },
      connectionId: "connection-old",
      sessionGeneration: 1,
      workloads: ["sandbox.command"],
      capacity: 1,
      leaseTimeoutMs: 100,
    })
  ) as SupervisorError;
  assertEquals(stale.code, "stale_session");

  const conflict = assertThrows(() =>
    registry.attach({
      identity: {
        workerId: "worker-1",
        attemptId: "attempt-other",
        epoch: 1,
      },
      connectionId: "connection-other",
      sessionGeneration: 1,
      workloads: ["sandbox.command"],
      capacity: 1,
      leaseTimeoutMs: 100,
    })
  ) as SupervisorError;
  assertEquals(conflict.code, "stale_session");
});
