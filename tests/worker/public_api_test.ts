import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createHypervisor,
  createWorker,
  type Hypervisor,
  type HypervisorLifecycleCallbacks,
  type InProcessTransport,
  type Worker,
  type WorkerLifecycleCallbacks,
} from "../../src/mod.ts";

type Assert<T extends true> = T;
type HasRun = "run" extends keyof Worker ? true : false;
type HasWhenReady = "whenReady" extends keyof Worker ? true : false;
type HasReady = "ready" extends keyof Worker ? true : false;
type HasClosed = "closed" extends keyof Worker ? true : false;
type HasDispatch = "dispatch" extends keyof Hypervisor ? true : false;

const workerContract: readonly [
  Assert<HasRun extends false ? true : false>,
  Assert<HasWhenReady extends false ? true : false>,
  Assert<HasReady>,
  Assert<HasClosed>,
  Assert<HasDispatch>,
] = [true, true, true, true, true];

function deferred<T = void>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((value) => void (resolve = value));
  return Object.freeze({ promise, resolve });
}

Deno.test("public capabilities expose promises and no run choreography", () => {
  assertEquals(workerContract, [true, true, true, true, true]);
});

Deno.test("one declaration changes only transport ownership", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `public-api-${crypto.randomUUID()}` },
  } as const satisfies InProcessTransport;
  const order: string[] = [];
  const hostCallbacks = {
    onConnect: () => void order.push("host.connect"),
    onAdmit: () => void order.push("host.admit"),
    onHandshake: () => void order.push("host.handshake"),
    onReady: () => void order.push("host.ready"),
    onWorkAssigned: () => void order.push("host.work_assigned"),
    onWorkAccepted: () => void order.push("host.work_accepted"),
    onStart: () => void order.push("host.start"),
    onComplete: () => void order.push("host.complete"),
  } satisfies HypervisorLifecycleCallbacks;
  const workerCallbacks = {
    onActivate: () => void order.push("worker.activate"),
    onRegister: () => void order.push("worker.register"),
    onHandshake: () => void order.push("worker.handshake"),
    onReady: () => void order.push("worker.ready"),
    onWorkAccepted: () => void order.push("worker.work_accepted"),
    onStart: () => void order.push("worker.start"),
    onComplete: () => void order.push("worker.complete"),
  } satisfies WorkerLifecycleCallbacks;
  const hypervisor = createHypervisor(
    { transports: [transport] },
    hostCallbacks,
  );
  const worker = createWorker(
    {
      id: "public-api-worker",
      transport,
      workloads: {
        echo: ({ input }) => input,
      },
    },
    workerCallbacks,
  );

  await worker.ready;
  const handle = await hypervisor.dispatch({
    workload: "echo",
    body: new TextEncoder().encode("canonical"),
  });
  assertEquals(await new Response(handle.output).text(), "canonical");
  assertEquals((await handle.completed).status, "completed");
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (
    const [before, after] of [
      ["worker.activate", "worker.register"],
      ["worker.register", "host.connect"],
      ["host.connect", "host.admit"],
      ["host.admit", "host.handshake"],
      ["host.handshake", "worker.handshake"],
      ["worker.handshake", "host.ready"],
      ["host.ready", "worker.ready"],
    ] as const
  ) {
    assertEquals(
      order.indexOf(before) < order.indexOf(after),
      true,
      `${before} must precede ${after}`,
    );
  }
  const assigned = order.indexOf("host.work_assigned");
  const workerAccepted = order.indexOf("worker.work_accepted");
  const hostAccepted = order.indexOf("host.work_accepted");
  const hostStart = order.indexOf("host.start");
  const workerStart = order.indexOf("worker.start");
  assertEquals(assigned < workerAccepted, true);
  assertEquals(workerAccepted < hostAccepted, true);
  assertEquals(hostAccepted < hostStart, true);
  assertEquals(hostStart < workerStart, true);

  await worker.stop();
  await hypervisor.shutdown();
});

Deno.test("Worker onReady gates public readiness and queued handler execution", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `ready-gate-${crypto.randomUUID()}` },
  } as const;
  const entered = deferred();
  const release = deferred();
  let invoked = false;
  const hypervisor = createHypervisor({ transports: [transport] });
  const worker = createWorker({
    id: "ready-gated-worker",
    transport,
    workloads: {
      task: () => {
        invoked = true;
        return new TextEncoder().encode("complete");
      },
    },
  }, {
    onReady() {
      entered.resolve();
      return release.promise;
    },
  });

  try {
    await entered.promise;
    const handle = await hypervisor.dispatch({ workload: "task" });
    await Promise.resolve();
    assertEquals(invoked, false);

    release.resolve();
    await worker.ready;
    assertEquals(await new Response(handle.output).text(), "complete");
    assertEquals((await handle.completed).status, "completed");
    assertEquals(invoked, true);
  } finally {
    release.resolve();
    await worker.stop();
    await hypervisor.shutdown();
  }
});

Deno.test("completion observer failure cannot rewrite work or close its session", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `complete-observer-${crypto.randomUUID()}` },
  } as const;
  const hypervisor = createHypervisor({ transports: [transport] }, {
    onComplete() {
      throw new Error("observer unavailable");
    },
  });
  const worker = createWorker({
    id: "complete-observer-worker",
    transport,
    workloads: {
      echo: ({ input }) => input,
    },
  });

  try {
    await worker.ready;
    for (const value of ["first", "second"]) {
      const handle = await hypervisor.dispatch({
        workload: "echo",
        body: new TextEncoder().encode(value),
      });
      assertEquals(await new Response(handle.output).text(), value);
      assertEquals((await handle.completed).status, "completed");
    }
    assertEquals(worker.snapshot().state, "ready");
  } finally {
    await worker.stop();
    await hypervisor.shutdown();
  }
});

Deno.test("Hypervisor onWorkAssigned fails before Open and releases capacity", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `assignment-gate-${crypto.randomUUID()}` },
  } as const;
  let accepted = false;
  let invoked = false;
  const hypervisor = createHypervisor({ transports: [transport] }, {
    onWorkAssigned() {
      throw new Error("assignment store unavailable");
    },
  });
  const worker = createWorker({
    id: "assignment-gated-worker",
    transport,
    workloads: {
      task: () => void (invoked = true),
    },
  }, {
    onWorkAccepted: () => void (accepted = true),
  });

  try {
    await worker.ready;
    await assertRejects(
      () => hypervisor.dispatch({ workload: "task" }),
      Error,
      "assignment store unavailable",
    );
    assertEquals(accepted, false);
    assertEquals(invoked, false);
    assertEquals(
      hypervisor.sessions.get("assignment-gated-worker")?.reserved,
      0,
    );
  } finally {
    await worker.stop();
    await hypervisor.shutdown();
  }
});

Deno.test("an event-fabric topic has one active Hypervisor owner", async () => {
  const transport = {
    type: "in-process",
    config: { topic: `collision-${crypto.randomUUID()}` },
  } as const;
  const first = createHypervisor({ transports: [transport] });
  assertThrows(
    () => createHypervisor({ transports: [transport] }),
    TypeError,
    "already bound",
  );
  await first.shutdown();
  const replacement = createHypervisor({ transports: [transport] });
  await replacement.shutdown();
});

Deno.test("a Worker cannot connect through an unbound ambient topic", async () => {
  const worker = createWorker({
    id: "unbound-worker",
    transport: {
      type: "in-process",
      config: { topic: `missing-${crypto.randomUUID()}` },
    },
    workloads: { noop: () => undefined },
  });
  await assertRejects(() => worker.ready, TypeError, "activate is required");
  await worker.closed.catch(() => undefined);
});
