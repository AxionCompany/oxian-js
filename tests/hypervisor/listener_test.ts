import { test } from "node:test";
import assert from "node:assert/strict";
import { observeListenerSettlement } from "../../src/hypervisor/internal/listener.ts";

test("listener settlement consumes rejection and removes its abort observer", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    let closeCalls = 0;
    let cleanupCalls = 0;

    observeListenerSettlement({
      finished: finished.promise,
      signal: controller.signal,
      close: () => {
        closeCalls++;
        return Promise.resolve();
      },
      cleanup: () => {
        cleanupCalls++;
      },
    });

    if (outcome === "resolve") finished.resolve();
    else finished.reject(new Error("listener failed"));
    await Promise.resolve();

    assert.deepStrictEqual(cleanupCalls, 1);
    controller.abort("late abort");
    await Promise.resolve();
    assert.deepStrictEqual(closeCalls, 0);
  }
});

test("listener abort closes once before later settlement cleanup", async () => {
  const controller = new AbortController();
  const finished = Promise.withResolvers<void>();
  let closeCalls = 0;
  let cleanupCalls = 0;

  observeListenerSettlement({
    finished: finished.promise,
    signal: controller.signal,
    close: () => {
      closeCalls++;
      return Promise.resolve();
    },
    cleanup: () => {
      cleanupCalls++;
    },
  });

  controller.abort("test abort");
  await Promise.resolve();
  assert.deepStrictEqual(closeCalls, 1);
  assert.deepStrictEqual(cleanupCalls, 0);

  finished.resolve();
  await Promise.resolve();
  assert.deepStrictEqual(closeCalls, 1);
  assert.deepStrictEqual(cleanupCalls, 1);
});
