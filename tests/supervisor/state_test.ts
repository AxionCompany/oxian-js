import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  createWorkDispatchTarget,
  createWorkerAttempt,
  createWorkerDefinition,
  isTerminalAttempt,
  transitionWorkerAttempt,
} from "../../src/supervisor/state.ts";
import type { JsonObject } from "../../src/protocol/types.ts";

const IDENTITY = {
  workerId: "worker-1",
  attemptId: "attempt-1",
  epoch: 1,
} as const;

Deno.test("work dispatch target factory validates, copies, and freezes input", () => {
  const input = { workerId: "worker-1", ignored: "not-public" };
  const target = createWorkDispatchTarget(input);

  input.workerId = "worker-2";
  assertEquals(target, { workerId: "worker-1" });
  assert(Object.isFrozen(target));
  assertEquals("ignored" in target, false);
  assertThrows(
    () => createWorkDispatchTarget({ workerId: "contains spaces" }),
    TypeError,
    "invalid identifier",
  );
  assertThrows(
    () => createWorkDispatchTarget(null as never),
    TypeError,
    "must be an object",
  );
});

Deno.test("worker definition factory validates, copies, and freezes input", () => {
  const providerConfig = { command: ["deno", "run"] };
  const definition = createWorkerDefinition({
    workerId: "worker-1",
    providerId: "local",
    workloads: ["sandbox.command", "sandbox.process"],
    capacity: 2,
    providerConfig,
    labels: { tenant: "tenant-1" },
  });

  providerConfig.command[0] = "changed";

  assertEquals(definition.providerConfig, {
    command: ["deno", "run"],
  });
  assert(Object.isFrozen(definition));
  assert(Object.isFrozen(definition.workloads));
  assert(Object.isFrozen(definition.providerConfig));
  assertThrows(
    () =>
      createWorkerDefinition({
        workerId: "worker-1",
        providerId: "local",
        workloads: [],
        capacity: 1,
      }),
    TypeError,
    "non-empty",
  );
});

Deno.test("worker definition JSON copying is prototype-safe and rejects non-JSON runtime values", () => {
  const dangerous = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"data"}',
  ) as JsonObject;
  const definition = createWorkerDefinition({
    workerId: "worker-1",
    providerId: "local",
    workloads: ["sandbox/command"],
    capacity: 1,
    providerConfig: dangerous,
  });

  assertEquals(
    Object.getPrototypeOf(definition.providerConfig),
    Object.prototype,
  );
  assertEquals(
    Object.hasOwn(definition.providerConfig, "__proto__"),
    true,
  );
  assertEquals(definition.providerConfig.__proto__, { polluted: true });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);

  assertThrows(
    () =>
      createWorkerDefinition({
        workerId: "worker-2",
        providerId: "local",
        workloads: ["sandbox.command"],
        capacity: 1,
        providerConfig: {
          invalid: undefined,
        } as unknown as JsonObject,
      }),
    TypeError,
    "expected a JSON value",
  );
});

Deno.test("worker attempt factory exposes only valid immutable transitions", () => {
  const requested = createWorkerAttempt({ identity: IDENTITY, nowMs: 10 });
  const launching = transitionWorkerAttempt(requested, {
    type: "launching",
  }, 11);
  const running = transitionWorkerAttempt(launching, {
    type: "running",
    providerInstanceId: "pid-42",
  }, 12);
  const terminating = transitionWorkerAttempt(running, {
    type: "terminate",
  }, 13);
  const terminated = transitionWorkerAttempt(terminating, {
    type: "terminated",
  }, 14);

  assertEquals(terminated.phase, "terminated");
  assertEquals(terminated.providerInstanceId, "pid-42");
  assertEquals(terminated.createdAtMs, 10);
  assertEquals(terminated.updatedAtMs, 14);
  assert(isTerminalAttempt(terminated));
  assertNotEquals(requested, launching);
  assert(Object.isFrozen(terminated));

  assertThrows(
    () =>
      transitionWorkerAttempt(terminated, {
        type: "running",
        providerInstanceId: "pid-2",
      }, 15),
    Error,
    "cannot mark an attempt running",
  );
});

Deno.test("worker attempts may fail before termination but never leave a terminal phase", () => {
  const requested = createWorkerAttempt({ identity: IDENTITY, nowMs: 10 });
  const failed = transitionWorkerAttempt(requested, {
    type: "failed",
    code: "launch_failed",
    message: "process exited",
  }, 11);

  assertEquals(failed.phase, "failed");
  assertEquals(failed.failure, {
    code: "launch_failed",
    message: "process exited",
  });
  assert(isTerminalAttempt(failed));
  assertThrows(
    () => transitionWorkerAttempt(failed, { type: "terminate" }, 12),
    Error,
    "cannot terminate",
  );
});
