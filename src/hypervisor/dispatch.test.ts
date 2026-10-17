import assert from "node:assert/strict";
import { test } from "node:test";
import type { HypervisorAssign } from "../lifecycle/types.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  fenceForSession,
  type SessionFence,
} from "../supervisor/index.ts";
import { createHypervisorConfig } from "./config.ts";
import { createDispatch } from "./internal/dispatch.ts";

function createHarness(assign?: HypervisorAssign, maxQueuedDispatches = 0) {
  const sessions = createSessionRegistry();
  const dispatcher = createWorkDispatcher({
    sessions,
    commitAcceptedWork: async () => {},
  });
  const host = new AbortController();
  const opened: SessionFence[] = [];
  const dispatch = createDispatch({
    config: createHypervisorConfig({ maxQueuedDispatches }),
    sessions,
    dispatcher,
    assign,
    signal: host.signal,
    clock: Date.now,
    scheduler: {
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    open(work) {
      opened.push(work.assignment!.fence);
      return {
        operationId: work.operationId,
        streamId: work.assignment!.streamId,
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        completed: Promise.resolve(work),
        output: new ReadableStream({
          start: (controller) => controller.close(),
        }),
        cancel: () => Promise.resolve(work),
      };
    },
  });
  const attach = (generation: number, workerId = "one") => {
    const { session } = sessions.attach({
      identity: { workerId, attemptId: "attempt", epoch: 1 },
      connectionId: `${workerId}-${generation}`,
      sessionGeneration: generation,
      transportType: "in-process",
      workloads: ["job"],
      capacity: 1,
      leaseTimeoutMs: 30_000,
    });
    const fence = fenceForSession(session);
    sessions.markReady(fence);
    return fence;
  };
  return { ...dispatch, sessions, dispatcher, host, opened, attach };
}

test("dispatch refuses a stale selected fence without spilling to its replacement", async () => {
  const selection = Promise.withResolvers<SessionFence>();
  const h = createHarness(() => selection.promise);
  try {
    const old = h.attach(1);
    const pending = h.dispatch({ workload: "job" });
    h.attach(2);
    h.attach(1, "other");
    selection.resolve(old);
    await assert.rejects(pending, { code: "worker_unavailable" });
    assert.deepEqual(h.opened, []);
    assert.deepEqual(h.dispatcher.list(), []);
    assert.equal(h.sessions.get("one")?.reserved, 0);
    assert.equal(h.sessions.get("other")?.reserved, 0);
  } finally {
    h.host.abort();
  }
});

test("logical worker target still resolves its current session", async () => {
  const h = createHarness();
  try {
    h.attach(1);
    const current = h.attach(2);
    await h.dispatch({ workload: "job", target: { workerId: "one" } });
    assert.deepEqual(h.opened, [current]);
  } finally {
    h.host.abort();
  }
});
