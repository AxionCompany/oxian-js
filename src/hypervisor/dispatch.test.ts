import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  HypervisorAssign,
  HypervisorWorkAssignedContext,
} from "../lifecycle/types.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  fenceForSession,
  type SessionFence,
} from "../supervisor/index.ts";
import { createHypervisorConfig, type HypervisorConfig } from "./config.ts";
import { createDispatch } from "./internal/dispatch.ts";

function createHarness(
  assign?: HypervisorAssign,
  maxQueuedDispatches = 0,
  onWorkAssigned?: (
    context: HypervisorWorkAssignedContext,
  ) => void | Promise<void>,
  config: Partial<HypervisorConfig> = {},
  onOpen?: () => void,
  polling = false,
) {
  let now = 1_000;
  const timers = new Map<object, { at: number; callback(): void }>();
  const registry = createSessionRegistry({ clock: () => now });
  const sessions = polling ? { ...registry, subscribe: undefined } : registry;
  const dispatcher = createWorkDispatcher({
    sessions,
    clock: () => now,
    commitAcceptedWork: async () => {},
  });
  const host = new AbortController();
  const opened: SessionFence[] = [];
  const dispatch = createDispatch({
    config: createHypervisorConfig({
      maxQueuedDispatches,
      dispatchQueueTimeoutMs: 100,
      ...config,
    }),
    sessions,
    dispatcher,
    assign,
    onWorkAssigned,
    signal: host.signal,
    clock: () => now,
    scheduler: {
      schedule(callback, delay) {
        const handle = {};
        timers.set(handle, { at: now + delay, callback });
        return handle;
      },
      cancel(handle) {
        timers.delete(handle as object);
      },
    },
    open(work) {
      opened.push(work.assignment!.fence);
      onOpen?.();
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
  async function tick(ms = 0) {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(handle)) timer.callback();
    }
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  return {
    ...dispatch,
    sessions,
    dispatcher,
    host,
    opened,
    attach,
    tick,
    timers,
  };
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

for (const queued of [0, 2]) {
  for (const stage of ["assign", "assigned"] as const) {
    test(`dispatch ${stage} deadline keeps unsettled hook occupancy (queue=${queued})`, async () => {
      const gate = Promise.withResolvers<void>();
      let calls = 0;
      let observed: AbortSignal | undefined;
      const hook = async (signal: AbortSignal) => {
        calls++;
        observed = signal;
        await gate.promise;
      };
      const h = createHarness(
        stage === "assign"
          ? async (context) => {
              await hook(context.signal);
              return context.available[0];
            }
          : undefined,
        queued,
        stage === "assigned" ? (context) => hook(context.signal) : undefined,
        { maxPendingDispatchHooks: 1 } as Partial<HypervisorConfig>,
      );
      h.attach(1);
      h.attach(1, "other");
      let outcome: unknown;
      const pending = h
        .dispatch({ workload: "job", target: { workerId: "one" } })
        .then(
          () => {
            outcome = "opened";
          },
          (error) => {
            outcome = error;
          },
        );
      try {
        await h.tick();
        await h.tick(100);
        assert.equal(
          (outcome as unknown as { code?: string })?.code,
          "deadline_exceeded",
        );
        assert.ok(observed?.aborted);
        assert.equal(h.snapshot().pendingDispatchHooks, 1);
        assert.equal(h.snapshot().queuedDispatches, 0);
        assert.equal(
          h.sessions.get("one")?.reserved,
          stage === "assigned" ? 1 : 0,
        );
        await assert.rejects(
          h.dispatch({ workload: "job", target: { workerId: "other" } }),
          { code: "dispatch_hook_capacity" },
        );
        assert.equal(calls, 1);
        gate.resolve();
        await h.tick();
        assert.equal(h.snapshot().pendingDispatchHooks, 0);
        assert.equal(h.sessions.get("one")?.reserved, 0);
        assert.equal(h.sessions.get("other")?.reserved, 0);
        assert.deepEqual(h.opened, []);
        assert.equal(h.timers.size, 0);
      } finally {
        gate.resolve();
        h.host.abort();
        await h.tick();
        await pending;
      }
    });
  }
}

for (const queued of [0, 2]) {
  test(`dispatch uses one deadline across assign and assigned hooks (queue=${queued})`, async () => {
    const select = Promise.withResolvers<void>();
    const assigned = Promise.withResolvers<void>();
    const h = createHarness(
      async ({ available }) => {
        await select.promise;
        return available[0];
      },
      queued,
      () => assigned.promise,
    );
    h.attach(1);
    let outcome: unknown;
    const pending = h.dispatch({ workload: "job" }).then(
      () => {
        outcome = "opened";
      },
      (error) => {
        outcome = error;
      },
    );
    try {
      await h.tick(40);
      select.resolve();
      await h.tick();
      assert.equal(h.sessions.get("one")?.reserved, 1);
      await h.tick(59);
      assert.equal(outcome, undefined);
      await h.tick(1);
      assert.equal(
        (outcome as unknown as { code?: string })?.code,
        "deadline_exceeded",
      );
      assert.equal(h.snapshot().pendingDispatchHooks, 1);
      assert.equal(h.sessions.get("one")?.reserved, 1);
      assert.equal(h.timers.size, 0);
      assigned.resolve();
      await h.tick();
      assert.equal(h.snapshot().pendingDispatchHooks, 0);
      assert.equal(h.sessions.get("one")?.reserved, 0);
      assert.deepEqual(h.opened, []);
    } finally {
      select.resolve();
      assigned.resolve();
      h.host.abort();
      await h.tick();
      await pending;
    }
  });

  for (const terminal of [
    "abort",
    "shutdown",
    "drain",
    "replacement",
  ] as const) {
    test(`dispatch assigned ${terminal} refuses promptly but holds its pending hook (queue=${queued})`, async () => {
      const gate = Promise.withResolvers<void>();
      let observed: AbortSignal | undefined;
      const h = createHarness(undefined, queued, ({ signal }) => {
        observed = signal;
        return gate.promise;
      });
      const old = h.attach(1);
      const caller = new AbortController();
      let outcome: unknown;
      const pending = h
        .dispatch({
          workload: "job",
          target: { workerId: "one" },
          signal: caller.signal,
        })
        .then(
          () => {
            outcome = "opened";
          },
          (error) => {
            outcome = error;
          },
        );
      try {
        await h.tick();
        assert.equal(h.sessions.get("one")?.reserved, 1);
        if (terminal === "abort") caller.abort("caller left");
        if (terminal === "shutdown") h.host.abort();
        if (terminal === "drain") h.sessions.startDrain(old);
        if (terminal === "replacement") {
          h.attach(2);
          h.dispatcher.connectionLost(old);
        }
        await h.tick();
        const expected = {
          abort: "dispatch_aborted",
          shutdown: "shutting_down",
          drain: "worker_draining",
          replacement: "worker_unavailable",
        }[terminal];
        assert.equal((outcome as unknown as { code?: string })?.code, expected);
        assert.ok(observed?.aborted);
        assert.equal(h.snapshot().pendingDispatchHooks, 1);
        assert.equal(h.timers.size, 0);
        if (terminal !== "replacement")
          assert.equal(h.sessions.get("one")?.reserved, 1);
        // A late reject after caller refusal must be handled, not become an
        // unhandled rejection or release somebody else's replacement capacity.
        gate.reject(new Error("late policy failure"));
        await h.tick();
        assert.equal(h.snapshot().pendingDispatchHooks, 0);
        assert.equal(h.sessions.get("one")?.reserved, 0);
        assert.deepEqual(h.opened, []);
        assert.deepEqual(h.dispatcher.list(), []);
      } finally {
        gate.resolve();
        h.host.abort();
        await h.tick();
        await pending;
      }
    });
  }

  test(`dispatch private cancellation survives callback signal tampering (queue=${queued})`, async () => {
    const gate = Promise.withResolvers<SessionFence>();
    const h = createHarness(({ signal }) => {
      Object.defineProperty(signal, "aborted", { value: false });
      Object.defineProperty(signal, "throwIfAborted", { value() {} });
      return gate.promise;
    }, queued);
    const fence = h.attach(1);
    const caller = new AbortController();
    const pending = assert.rejects(
      h.dispatch({ workload: "job", signal: caller.signal }),
      { code: "dispatch_aborted" },
    );
    caller.abort();
    await pending;
    gate.resolve(fence);
    await h.tick();
    assert.equal(h.snapshot().pendingDispatchHooks, 0);
    assert.equal(h.sessions.get("one")?.reserved, 0);
    assert.deepEqual(h.opened, []);
    h.host.abort();
  });

  test(`dispatch honors a shorter caller deadline and never opens at expiry (queue=${queued})`, async () => {
    const gate = Promise.withResolvers<void>();
    const h = createHarness(undefined, queued, () => gate.promise);
    h.attach(1);
    const pending = assert.rejects(
      h.dispatch({ workload: "job", deadlineAtMs: 1_010 }),
      { code: "deadline_exceeded" },
    );
    await h.tick();
    await h.tick(10);
    gate.resolve();
    await pending;
    await h.tick();
    assert.deepEqual(h.opened, []);
    assert.equal(h.snapshot().pendingDispatchHooks, 0);
    assert.equal(h.timers.size, 0);
    h.host.abort();
  });
}

test("dispatch hook bounds reject invalid configuration", () => {
  assert.equal(createHypervisorConfig().maxPendingDispatchHooks, 1_024);
  for (const value of [0, -1, 0.5, NaN, Infinity, 1_000_001]) {
    assert.throws(
      () => createHypervisorConfig({ maxPendingDispatchHooks: value }),
      /maxPendingDispatchHooks/,
    );
  }
});

for (const terminal of ["abort", "deadline", "replacement"] as const) {
  test(`dispatch Open handoff cannot lose its handle to a late ${terminal}`, async () => {
    const caller = new AbortController();
    const h = createHarness(
      undefined,
      0,
      async () => {},
      {},
      () => {
        queueMicrotask(() => {
          if (terminal === "abort") caller.abort();
          if (terminal === "deadline") void h.tick(100);
          if (terminal === "replacement") h.attach(2);
        });
      },
    );
    h.attach(1);
    try {
      const handle = await h.dispatch({
        workload: "job",
        signal: caller.signal,
      });
      assert.equal(
        handle.streamId,
        h.dispatcher.get(handle.operationId)?.assignment?.streamId,
      );
      assert.equal(h.opened.length, 1);
      assert.equal(h.snapshot().pendingDispatchHooks, 0);
      assert.equal(h.timers.size, 0);
    } finally {
      h.host.abort();
    }
  });
}

test("dispatch Open failure after lifecycle handoff still withdraws its offer", async () => {
  const h = createHarness(
    undefined,
    0,
    async () => {},
    {},
    () => {
      throw new Error("route failed");
    },
  );
  h.attach(1);
  try {
    await assert.rejects(h.dispatch({ workload: "job" }), {
      code: "worker_unavailable",
    });
    assert.equal(h.sessions.get("one")?.reserved, 0);
    assert.deepEqual(h.dispatcher.list(), []);
    assert.equal(h.timers.size, 0);
  } finally {
    h.host.abort();
  }
});

for (const terminal of ["replacement", "drain"] as const) {
  test(`custom registries poll an unsettled assigned hook for ${terminal}`, async () => {
    const gate = Promise.withResolvers<void>();
    const h = createHarness(
      undefined,
      0,
      () => gate.promise,
      {},
      undefined,
      true,
    );
    const old = h.attach(1);
    let outcome: unknown;
    const pending = h.dispatch({ workload: "job" }).catch((error) => {
      outcome = error;
    });
    try {
      await h.tick();
      if (terminal === "replacement") h.attach(2);
      else h.sessions.startDrain(old);
      await h.tick(24);
      assert.equal(outcome, undefined);
      await h.tick(1);
      assert.equal(
        (outcome as unknown as { code?: string })?.code,
        terminal === "replacement" ? "worker_unavailable" : "worker_draining",
      );
      assert.equal(h.snapshot().pendingDispatchHooks, 1);
      assert.equal(h.timers.size, 0);
      gate.resolve();
      await h.tick();
      assert.equal(h.snapshot().pendingDispatchHooks, 0);
      assert.deepEqual(h.opened, []);
    } finally {
      gate.resolve();
      h.host.abort();
      await h.tick();
      await pending;
    }
  });
}
