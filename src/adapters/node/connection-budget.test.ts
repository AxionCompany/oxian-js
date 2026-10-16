import assert from "node:assert/strict";
import { connect as connectTcp } from "node:net";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import {
  CONNECTION_BUDGET,
  createConnectionBudget,
} from "./connection-budget.ts";
import { serve } from "./server.ts";

test("the connection budget refuses excess connections and releases once", () => {
  const budget = createConnectionBudget(2);
  const first = budget.connect();
  const second = budget.connect();
  assert.throws(() => budget.connect(), /connection budget exceeded/);
  first.release();
  const third = budget.connect();
  third.release();
  third.release();
  assert.deepEqual(budget.snapshot(), { connections: 1, budget: 2 });
  budget.close();
  assert.throws(() => budget.connect(), /closed/);
  second.release();
  assert.equal(budget.snapshot().connections, 0);
});

test("connection budgets default to the cap and reject invalid limits", () => {
  assert.deepEqual(createConnectionBudget().snapshot(), {
    connections: 0,
    budget: CONNECTION_BUDGET,
  });
  for (const limit of [
    0,
    -1,
    1.5,
    Number.NaN,
    Infinity,
    CONNECTION_BUDGET + 1,
  ]) {
    assert.throws(() => createConnectionBudget(limit), RangeError);
  }
});

test("Node listeners share a budget and release rejected upgrades", async () => {
  const budget = createConnectionBudget(1);
  const hypervisor = createHypervisor({
    transports: [
      {
        type: "in-process",
        config: { topic: `budget-${crypto.randomUUID()}` },
      },
    ],
    fallback: () => new Response("no upgrade route", { status: 404 }),
  });
  const first = await serve({ hypervisor, budget });
  const second = await serve({ hypervisor, budget });
  try {
    const held = budget.connect();
    assert.equal(await upgradeStatus(first.port), 503);
    assert.equal(await upgradeStatus(second.port), 503);
    held.release();
    // A rejected upgrade must release its lease on socket close.
    assert.equal(await upgradeStatus(first.port), 404);
    await waitForRelease();
    assert.equal(await upgradeStatus(second.port), 404);
    await waitForRelease();
    assert.equal(budget.snapshot().connections, 0);
  } finally {
    await first.shutdown();
    await second.shutdown();
    await hypervisor.shutdown("budget_test");
  }

  async function waitForRelease(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (budget.snapshot().connections === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("rejected upgrade retained its connection lease");
  }
});

function upgradeStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    const timer = setTimeout(() => finish(new Error("no status")), 2_000);
    let text = "";
    socket.once("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const status = /^HTTP\/1\.1 (\d+)/.exec(text)?.[1];
      if (status !== undefined) finish(undefined, Number(status));
    });
    socket.once("error", (error) => finish(error));
    function finish(error?: Error, status?: number): void {
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(status!);
    }
  });
}
