import { assertEquals, assertRejects } from "@std/assert";
import { bounded, queueHarness } from "./queue_regression_helpers.ts";

for (const transport of ["in-process", "websocket"] as const) {
  Deno.test(`${transport}: saturated target does not block the same workload on an idle target`, async () => {
    const release = Promise.withResolvers<void>();
    const running = Promise.withResolvers<void>();
    const h = await queueHarness(transport, async ({ metadata }) => {
      if (metadata.hold) {
        running.resolve();
        await release.promise;
      }
      return new TextEncoder().encode(String(metadata.id));
    });
    const tasks: Promise<unknown>[] = [];
    try {
      tasks.push(
        h.run({
          target: { workerId: "A" },
          metadata: { id: "A1", hold: true },
        }),
      );
      await bounded(running.promise);
      tasks.push(h.run({ target: { workerId: "A" }, metadata: { id: "A2" } }));
      const idle = h.run({ target: { workerId: "B" }, metadata: { id: "B1" } });
      tasks.push(idle);
      // A is held by a gate, so this asserts independence without timing the handler.
      assertEquals(await bounded(idle, 500), "B1");
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 1);
    } finally {
      release.resolve();
      await Promise.allSettled(tasks);
      await h.close();
    }
  });

  Deno.test(`${transport}: queued dispatch waits for Worker completion hook and output EOF`, async () => {
    const releaseHook = Promise.withResolvers<void>();
    const hookEntered = Promise.withResolvers<void>();
    const outputEOF = Promise.withResolvers<void>();
    const outputStarted = Promise.withResolvers<void>();
    const assignments: string[] = [];
    const starts: string[] = [];
    let occupiedAtSecondAssignment = -1;
    const h = await queueHarness(
      transport,
      ({ metadata }) => {
        starts.push(String(metadata.id));
        if (metadata.id !== "first") return new TextEncoder().encode("next");
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            outputStarted.resolve();
            await outputEOF.promise;
            controller.close();
          },
        });
      },
      {
        async onComplete({ metadata }) {
          if (metadata.id === "first") {
            hookEntered.resolve();
            await releaseHook.promise;
          }
        },
      },
      1,
      16,
      {
        onWorkAssigned({ metadata }) {
          assignments.push(String(metadata.id));
          if (metadata.id === "second") {
            occupiedAtSecondAssignment =
              h.workers[0].snapshot().occupiedExecutions;
          }
        },
      },
    );
    const tasks: Promise<unknown>[] = [];
    try {
      tasks.push(
        h.run({ target: { workerId: "A" }, metadata: { id: "first" } }),
      );
      await bounded(outputStarted.promise);
      const second = h.run({
        target: { workerId: "A" },
        metadata: { id: "second" },
      });
      tasks.push(second);
      // Attach rejection observers now, including on the old implementation.
      const all = Promise.allSettled(tasks);
      assertEquals(assignments, ["first"]);
      outputEOF.resolve();
      await bounded(hookEntered.promise);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(assignments, ["first"]);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 1);
      releaseHook.resolve();
      assertEquals((await bounded(all)).map((result) => result.status), [
        "fulfilled",
        "fulfilled",
      ]);
      assertEquals(starts, ["first", "second"]);
      assertEquals(occupiedAtSecondAssignment, 0);
    } finally {
      outputEOF.resolve();
      releaseHook.resolve();
      await Promise.allSettled(tasks);
      await h.close();
    }
  });

  Deno.test(`${transport}: mixed lanes use idle capacity without waiting for a saturated target`, async () => {
    const releaseA = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    const aStarted = Promise.withResolvers<void>();
    const bStarted = Promise.withResolvers<void>();
    const starts: string[] = [];
    const h = await queueHarness(transport, async ({ metadata }) => {
      starts.push(String(metadata.id));
      if (metadata.id === "A1") {
        aStarted.resolve();
        await releaseA.promise;
      }
      if (metadata.id === "U1") {
        bStarted.resolve();
        await releaseB.promise;
      }
      return new TextEncoder().encode(String(metadata.id));
    });
    const tasks: Promise<unknown>[] = [];
    try {
      tasks.push(h.run({ target: { workerId: "A" }, metadata: { id: "A1" } }));
      await bounded(aStarted.promise);
      tasks.push(h.run({ target: { workerId: "A" }, metadata: { id: "A2" } }));
      tasks.push(h.run({ metadata: { id: "U1" } }));
      await bounded(bStarted.promise, 500);
      const untargeted = h.run({ metadata: { id: "U2" } });
      const targeted = h.run({
        target: { workerId: "B" },
        metadata: { id: "B1" },
      });
      tasks.push(untargeted, targeted);
      releaseB.resolve();
      assertEquals(await bounded(Promise.all([untargeted, targeted])), [
        "U2",
        "B1",
      ]);
      assertEquals(starts, ["A1", "U1", "U2", "B1"]);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 1);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled(tasks);
      await h.close();
    }
  });

  Deno.test(`${transport}: handler failure releases execution capacity before notifying the Hypervisor`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const h = await queueHarness(transport, ({ metadata }) => {
      if (metadata.fail) throw new Error("expected handler failure");
      return new TextEncoder().encode("ok");
    }, {
      async onComplete({ metadata }) {
        if (metadata.fail) {
          entered.resolve();
          await release.promise;
        }
      },
    });
    const tasks: Promise<unknown>[] = [];
    try {
      tasks.push(
        assertRejects(
          () => h.run({ target: { workerId: "A" }, metadata: { fail: true } }),
          Error,
          "expected handler failure",
        ),
      );
      await bounded(entered.promise);
      const next = h.run({ target: { workerId: "A" } });
      tasks.push(next);
      assertEquals(h.hypervisor.snapshot().queuedDispatches, 1);
      release.resolve();
      assertEquals(await bounded(next), "ok");
      await bounded(Promise.all(tasks));
    } finally {
      release.resolve();
      await Promise.allSettled(tasks);
      await h.close();
    }
  });

  Deno.test(`${transport}: immediate redispatch after completion works with queueing disabled`, async () => {
    const h = await queueHarness(
      transport,
      () => new TextEncoder().encode("ok"),
      {
        onComplete: () => new Promise((resolve) => setTimeout(resolve, 25)),
      },
      1,
      0,
    );
    try {
      for (let i = 0; i < 3; i++) {
        assertEquals(await bounded(h.run({ target: { workerId: "A" } })), "ok");
        assertEquals(h.workers[0].snapshot().occupiedExecutions, 0);
      }
    } finally {
      await h.close();
    }
  });
}
