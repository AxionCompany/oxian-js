import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
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

test("work dispatch target factory validates, copies, and freezes input", () => {
  const input = { workerId: "worker-1", ignored: "not-public" };
  const target = createWorkDispatchTarget(input);

  input.workerId = "worker-2";
  assert.deepStrictEqual(target, { workerId: "worker-1" });
  assert.ok(Object.isFrozen(target));
  assert.deepStrictEqual("ignored" in target, false);
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

test("worker definition factory validates, copies, and freezes input", () => {
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

  assert.deepStrictEqual(definition.providerConfig, {
    command: ["deno", "run"],
  });
  assert.ok(Object.isFrozen(definition));
  assert.ok(Object.isFrozen(definition.workloads));
  assert.ok(Object.isFrozen(definition.providerConfig));
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

test("worker definition JSON copying is prototype-safe and rejects non-JSON runtime values", () => {
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

  assert.deepStrictEqual(
    Object.getPrototypeOf(definition.providerConfig),
    Object.prototype,
  );
  assert.deepStrictEqual(
    Object.hasOwn(definition.providerConfig, "__proto__"),
    true,
  );
  assert.deepStrictEqual(definition.providerConfig.__proto__, {
    polluted: true,
  });
  assert.deepStrictEqual(({} as Record<string, unknown>).polluted, undefined);

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

test("worker attempt factory exposes only valid immutable transitions", () => {
  const requested = createWorkerAttempt({ identity: IDENTITY, nowMs: 10 });
  const launching = transitionWorkerAttempt(
    requested,
    {
      type: "launching",
    },
    11,
  );
  const running = transitionWorkerAttempt(
    launching,
    {
      type: "running",
      providerInstanceId: "pid-42",
    },
    12,
  );
  const terminating = transitionWorkerAttempt(
    running,
    {
      type: "terminate",
    },
    13,
  );
  const terminated = transitionWorkerAttempt(
    terminating,
    {
      type: "terminated",
    },
    14,
  );

  assert.deepStrictEqual(terminated.phase, "terminated");
  assert.deepStrictEqual(terminated.providerInstanceId, "pid-42");
  assert.deepStrictEqual(terminated.createdAtMs, 10);
  assert.deepStrictEqual(terminated.updatedAtMs, 14);
  assert.ok(isTerminalAttempt(terminated));
  assert.notDeepStrictEqual(requested, launching);
  assert.ok(Object.isFrozen(terminated));

  assertThrows(
    () =>
      transitionWorkerAttempt(
        terminated,
        {
          type: "running",
          providerInstanceId: "pid-2",
        },
        15,
      ),
    Error,
    "cannot mark an attempt running",
  );
});

test("worker attempts may fail before termination but never leave a terminal phase", () => {
  const requested = createWorkerAttempt({ identity: IDENTITY, nowMs: 10 });
  const failed = transitionWorkerAttempt(
    requested,
    {
      type: "failed",
      code: "launch_failed",
      message: "process exited",
    },
    11,
  );

  assert.deepStrictEqual(failed.phase, "failed");
  assert.deepStrictEqual(failed.failure, {
    code: "launch_failed",
    message: "process exited",
  });
  assert.ok(isTerminalAttempt(failed));
  assertThrows(
    () => transitionWorkerAttempt(failed, { type: "terminate" }, 12),
    Error,
    "cannot terminate",
  );
});
