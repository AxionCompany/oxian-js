import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHypervisorConfig } from "../../src/hypervisor/config.ts";
import { createDispatch } from "../../src/hypervisor/internal/dispatch.ts";
import type { HypervisorAssign } from "../../src/lifecycle/index.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  fenceForSession,
  type SessionFence,
} from "../../src/supervisor/index.ts";
import type { WorkHandle } from "../../src/work/types.ts";

async function code(promise: Promise<unknown>, expected: string) {
  const error = await assertRejects(() => promise);
  assertEquals((error as Error & { code: string }).code, expected);
  return error as Error;
}

function harness(
  assign?: HypervisorAssign,
  maxQueuedDispatches = 8,
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
  const opened: string[] = [];
  const controller = createDispatch({
    config: createHypervisorConfig({
      maxQueuedDispatches,
      dispatchQueueTimeoutMs: 100,
    }),
    sessions,
    dispatcher,
    assign,
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
      opened.push(String(work.metadata.order));
      return {
        operationId: work.operationId,
        streamId: work.assignment!.streamId,
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        completed: Promise.resolve(work),
        output: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        cancel: () =>
          Promise.resolve(dispatcher.withdrawOffer(
            work.operationId,
            work.assignment!.fence,
            work.assignment!.streamId,
          )),
      };
    },
  });
  function attach(workerId = "one", workloads = ["job"], generation = 1) {
    const session = sessions.attach({
      identity: { workerId, attemptId: "attempt", epoch: 1 },
      connectionId: `${workerId}-${generation}`,
      sessionGeneration: generation,
      transportType: "in-process",
      workloads,
      capacity: 1,
      leaseTimeoutMs: 10_000,
    }).session;
    const fence = fenceForSession(session);
    sessions.markReady(fence);
    return fence;
  }
  function release(handle: WorkHandle) {
    const work = dispatcher.get(handle.operationId)!;
    dispatcher.withdrawOffer(
      work.operationId,
      work.assignment!.fence,
      work.assignment!.streamId,
    );
  }
  async function tick(ms = 0) {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(handle)) timer.callback();
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  return {
    ...controller,
    sessions,
    dispatcher,
    host,
    timers,
    opened,
    attach,
    release,
    tick,
  };
}

Deno.test("dispatch queue: arrival order among runnable heads and FIFO across workloads on a target", async () => {
  const h = harness();
  h.attach("one", ["job", "other"]);
  const first = await h.dispatch({
    workload: "job",
    target: { workerId: "one" },
    metadata: { order: 1 },
  });
  const second = h.dispatch({ workload: "job", metadata: { order: 2 } });
  const third = h.dispatch({
    workload: "job",
    target: { workerId: "one" },
    metadata: { order: 3 },
  });
  const fourth = h.dispatch({
    workload: "other",
    target: { workerId: "one" },
    metadata: { order: 4 },
  });
  assertEquals(h.snapshot(), {
    queuedDispatches: 3,
    queuedDispatchesByLane: [
      { workload: "job", count: 1 },
      { workload: "job", workerId: "one", count: 1 },
      { workload: "other", workerId: "one", count: 1 },
    ],
  });
  assertEquals(h.dispatcher.list().length, 1);
  h.release(first);
  h.release(await second);
  h.release(await third);
  h.release(await fourth);
  assertEquals(h.opened, ["1", "2", "3", "4"]);
  assertEquals(h.snapshot().queuedDispatches, 0);
  assertEquals(h.timers.size, 0);
  h.host.abort();
});

Deno.test("dispatch queue: independent lanes proceed, absent target retains exact routing", async () => {
  const h = harness();
  h.attach("other", ["job", "independent"]);
  const waiting = h.dispatch({
    workload: "job",
    target: { workerId: "missing" },
  });
  const unrelated = await h.dispatch({
    workload: "independent",
    target: { workerId: "other" },
  });
  assertEquals(h.snapshot().queuedDispatches, 1);
  h.attach("missing");
  const result = await waiting;
  assertEquals(
    h.dispatcher.get(result.operationId)?.assignment?.fence.identity.workerId,
    "missing",
  );
  h.release(result);
  h.release(unrelated);
  h.host.abort();
});

Deno.test("dispatch queue: deadline, default timeout, abort cause, full queue, and untouched body", async () => {
  const h = harness(undefined, 2);
  let pulled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      pulled = true;
    },
  }, { highWaterMark: 0 });
  const abort = new AbortController();
  const first = code(
    h.dispatch({ workload: "job", deadlineAtMs: 1_010, body }),
    "deadline_exceeded",
  );
  const second = code(
    h.dispatch({ workload: "job", signal: abort.signal }),
    "dispatch_aborted",
  );
  await code(h.dispatch({ workload: "job" }), "dispatch_queue_full");
  abort.abort("caller left");
  assertEquals((await second).cause, "caller left");
  await h.tick(10);
  await first;
  assertEquals(pulled, false);
  assertEquals(body.locked, false);
  const fallback = code(
    h.dispatch({ workload: "job", deadlineAtMs: 100_000 }),
    "deadline_exceeded",
  );
  await h.tick(100);
  await fallback;
  await code(
    h.dispatch({ workload: "job", deadlineAtMs: 0 }),
    "deadline_exceeded",
  );
  await code(
    h.dispatch({ workload: "job", signal: AbortSignal.abort("already") }),
    "dispatch_aborted",
  );
  assertEquals(h.dispatcher.list(), []);
  assertEquals(h.timers.size, 0);
  h.host.abort();
});

Deno.test("dispatch queue: drain rejects target, untargeted survives; shutdown rejects all and future dispatch", async () => {
  const h = harness();
  const fence = h.attach();
  const active = await h.dispatch({ workload: "job" });
  const targeted = code(
    h.dispatch({ workload: "job", target: { workerId: "one" } }),
    "worker_draining",
  );
  const untargeted = code(h.dispatch({ workload: "job" }), "shutting_down");
  h.sessions.startDrain(fence);
  await targeted;
  await code(
    h.dispatch({ workload: "job", target: { workerId: "one" } }),
    "worker_draining",
  );
  assertEquals(h.snapshot().queuedDispatches, 1);
  h.host.abort();
  await untargeted;
  await code(h.dispatch({ workload: "job" }), "shutting_down");
  h.release(active);
  assertEquals(h.timers.size, 0);
});

Deno.test("dispatch queue: cancelled asynchronous assignment cannot offer late", async () => {
  for (const terminal of ["abort", "deadline", "shutdown", "drain"] as const) {
    const selection = Promise.withResolvers<SessionFence | undefined>();
    let observedSignal: AbortSignal | undefined;
    const h = harness((context) => {
      observedSignal = context.signal;
      return selection.promise;
    });
    const fence = h.attach();
    const abort = new AbortController();
    const expected = {
      abort: "dispatch_aborted",
      deadline: "deadline_exceeded",
      shutdown: "shutting_down",
      drain: "worker_draining",
    }[terminal];
    const waiting = code(
      h.dispatch({
        workload: "job",
        target: { workerId: "one" },
        signal: abort.signal,
      }),
      expected,
    );
    if (terminal === "abort") abort.abort();
    if (terminal === "deadline") await h.tick(100);
    if (terminal === "shutdown") h.host.abort();
    if (terminal === "drain") h.sessions.startDrain(fence);
    await waiting;
    assert(observedSignal?.aborted);
    selection.resolve(fence);
    await h.tick();
    assertEquals(h.opened, []);
    assertEquals(h.dispatcher.list(), []);
    assertEquals(h.sessions.get("one")?.reserved, 0);
    h.host.abort();
    assertEquals(h.timers.size, 0);
  }
});

Deno.test("dispatch queue: stale async selection retries with stable operation and incrementing callbackAttempt", async () => {
  const selection = Promise.withResolvers<SessionFence | undefined>();
  const attempts: { stageId: string; callbackAttempt: number }[] = [];
  const h = harness((context) => {
    attempts.push(context);
    return attempts.length === 1 ? selection.promise : context.available[0];
  });
  const old = h.attach();
  const waiting = h.dispatch({ workload: "job" });
  const replacement = h.attach("one", ["job"], 2);
  selection.resolve(old);
  const result = await waiting;
  assertEquals(attempts.map((x) => x.callbackAttempt), [1, 2]);
  assertEquals(attempts[0].stageId, attempts[1].stageId);
  assertEquals(
    h.dispatcher.get(result.operationId)?.assignment?.fence,
    replacement,
  );
  h.release(result);
  h.host.abort();
});

Deno.test("dispatch queue: invalid input and policy errors fail without waiting or leaked reservations", async () => {
  const h = harness(() => {
    throw new Error("policy failed");
  });
  await assertRejects(() => h.dispatch({ workload: "" }), TypeError);
  await assertRejects(
    () => h.dispatch({ workload: "job", deadlineAtMs: NaN }),
    TypeError,
  );
  h.attach();
  await assertRejects(
    () => h.dispatch({ workload: "job" }),
    Error,
    "policy failed",
  );
  assertEquals(h.snapshot().queuedDispatches, 0);
  assertEquals(h.dispatcher.list(), []);
  h.host.abort();
});

Deno.test("dispatch queue: custom registry without subscription polls only while queued", async () => {
  const h = harness(undefined, 8, true);
  const waiting = h.dispatch({ workload: "job" });
  h.attach();
  await h.tick(25);
  h.release(await waiting);
  assertEquals(h.timers.size, 0);
  h.host.abort();
});

Deno.test("dispatch queue: default capacity rejection remains compatible", async () => {
  const h = harness(undefined, 0);
  await code(h.dispatch({ workload: "job" }), "worker_unavailable");
  h.attach();
  const active = await h.dispatch({ workload: "job" });
  await code(h.dispatch({ workload: "job" }), "worker_unavailable");
  assertEquals(h.snapshot().queuedDispatches, 0);
  h.release(active);
  h.host.abort();
});

Deno.test("dispatch queue: capacity stolen during assign waits for release before retry", async () => {
  const selection = Promise.withResolvers<SessionFence | undefined>();
  let calls = 0;
  const h = harness((context) =>
    ++calls === 1 ? selection.promise : context.available[0]
  );
  const fence = h.attach();
  const waiting = h.dispatch({ workload: "job" });
  const competing = h.dispatcher.offer({ workload: "job" });
  selection.resolve(fence);
  await h.tick();
  assertEquals(h.snapshot().queuedDispatches, 1);
  assertEquals(calls, 1);
  h.dispatcher.withdrawOffer(
    competing.operationId,
    fence,
    competing.assignment!.streamId,
  );
  const result = await waiting;
  assertEquals(calls, 2);
  h.release(result);
  h.host.abort();
});

Deno.test("dispatch queue: registry observer failure cannot strand a reservation", async () => {
  const h = harness();
  const unsubscribe = h.sessions.subscribe!(() => {
    throw new Error("observer failed");
  });
  h.attach();
  const active = await h.dispatch({ workload: "job" });
  const waiting = h.dispatch({ workload: "job" });
  h.release(active);
  h.release(await waiting);
  assertEquals(h.sessions.get("one")?.reserved, 0);
  assertEquals(h.dispatcher.list(), []);
  unsubscribe();
  h.host.abort();
});
