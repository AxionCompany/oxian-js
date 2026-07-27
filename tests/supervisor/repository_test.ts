import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SupervisorError } from "../../src/supervisor/types.ts";
import { createInMemoryWorkerRepository } from "../../src/supervisor/repository.ts";
import { createWorkerDefinition } from "../../src/supervisor/state.ts";

async function createRepository() {
  let nowMs = 100;
  let attemptNumber = 0;
  const repository = createInMemoryWorkerRepository({
    clock: () => nowMs++,
    createAttemptId: () => `attempt-${++attemptNumber}`,
  });
  await repository.define(createWorkerDefinition({
    workerId: "worker-1",
    providerId: "local",
    workloads: ["sandbox.command"],
    capacity: 1,
  }));
  return repository;
}

Deno.test("repository activation is atomic and reuses the active attempt", async () => {
  const repository = await createRepository();

  const activations = await Promise.all(
    Array.from({ length: 32 }, () => repository.activate("worker-1")),
  );

  assertEquals(
    activations.filter((activation) => activation.created).length,
    1,
  );
  assert(
    activations.every((activation) =>
      activation.attempt.identity.attemptId === "attempt-1"
    ),
  );
  assertEquals((await repository.listAttempts("worker-1")).length, 1);
});

Deno.test("repository transition uses attempt identity and source phase as a CAS", async () => {
  const repository = await createRepository();
  const attempt = (await repository.activate("worker-1")).attempt;

  const transitions = await Promise.allSettled([
    repository.transition(attempt.identity, { type: "launching" }),
    repository.transition(attempt.identity, { type: "launching" }),
  ]);

  assertEquals(
    transitions.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assertEquals(
    transitions.filter((result) => result.status === "rejected").length,
    1,
  );
  assertEquals(
    (await repository.currentAttempt("worker-1"))?.phase,
    "launching",
  );
});

Deno.test("repository fences transitions by attempt ID and epoch", async () => {
  const repository = await createRepository();
  const first = (await repository.activate("worker-1")).attempt;
  await repository.transition(first.identity, { type: "launching" });
  await repository.transition(first.identity, {
    type: "failed",
    code: "launch_failed",
    message: "provider rejected launch",
  });

  const second = (await repository.activate("worker-1")).attempt;
  assertEquals(second.identity.epoch, 2);
  assertEquals(second.identity.attemptId, "attempt-2");

  const error = await assertRejects(
    () => repository.transition(first.identity, { type: "launching" }),
  ) as SupervisorError;
  assertEquals(error.code, "stale_attempt");
  assertEquals(await repository.assertCurrent(second.identity), second);
  assertEquals((await repository.listAttempts("worker-1")).length, 2);
});

Deno.test("repository keeps definitions and attempts semantically separate", async () => {
  const repository = await createRepository();
  const definition = await repository.getDefinition("worker-1");
  const attempt = (await repository.activate("worker-1")).attempt;

  assertEquals(definition?.providerId, "local");
  assertEquals(attempt.phase, "requested");
  assertEquals("phase" in definition!, false);
  await assertRejects(
    () => repository.define(definition!),
    Error,
    "already defined",
  );
});

Deno.test("repository normalizes definitions instead of trusting caller objects", async () => {
  const repository = createInMemoryWorkerRepository();
  const callerOwned = {
    workerId: "worker-raw",
    providerId: "local",
    workloads: ["sandbox/command"],
    capacity: 1,
    providerConfig: { command: ["deno", "run"] },
    labels: {},
  };

  const stored = await repository.define(callerOwned);
  callerOwned.workloads[0] = "changed";
  callerOwned.providerConfig.command[0] = "changed";

  assertEquals(stored.workloads, ["sandbox/command"]);
  assertEquals(stored.providerConfig, { command: ["deno", "run"] });
  assert(Object.isFrozen(stored));
  assert(Object.isFrozen(stored.providerConfig));
});
