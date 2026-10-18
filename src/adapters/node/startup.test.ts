import assert from "node:assert/strict";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import { serve } from "./server.ts";

function fixture() {
  return createHypervisor({
    transports: [
      { type: "in-process", config: { topic: crypto.randomUUID() } },
    ],
    fallback: () => new Response("healthy"),
  });
}

test("failed Node bind is handled and leaves caller-owned Hypervisor reusable", async () => {
  const hypervisor = fixture();
  const first = await serve({ hypervisor });
  try {
    await assert.rejects(serve({ hypervisor, port: first.port }), {
      code: "EADDRINUSE",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await (await fetch(first.url)).text(), "healthy");
    assert.equal(hypervisor.snapshot().acceptingConnections, true);
    const replacement = await serve({ hypervisor });
    await replacement.shutdown();
    await replacement.finished;
  } finally {
    await first.shutdown();
    await hypervisor.shutdown();
  }
});

test("Node startup cancellation rejects promptly without owning the Hypervisor", async () => {
  const hypervisor = fixture();
  const controller = new AbortController();
  const cause = new Error("cancel startup");
  const starting = serve({ hypervisor, signal: controller.signal });
  controller.abort(cause);
  try {
    await assert.rejects(starting, (error) => error === cause);
    assert.equal(hypervisor.snapshot().acceptingConnections, true);
    const listener = await serve({ hypervisor });
    await listener.shutdown();
    await listener.finished;
  } finally {
    await hypervisor.shutdown();
  }
});

test("already aborted Node startup acquires no listener", async () => {
  const hypervisor = fixture();
  const cause = new Error("already aborted");
  try {
    await assert.rejects(
      serve({ hypervisor, signal: AbortSignal.abort(cause) }),
      (error) => error === cause,
    );
    assert.equal(hypervisor.snapshot().acceptingConnections, true);
  } finally {
    await hypervisor.shutdown();
  }
});
