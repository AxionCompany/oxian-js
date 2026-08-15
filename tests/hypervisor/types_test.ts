import { assertEquals, assertThrows } from "@std/assert";
import {
  createHypervisor,
  type HypervisorAdmit,
  type HypervisorTransport,
} from "../../src/mod.ts";

const path = "/workers/connect";

const rejectUnknownWorker: HypervisorAdmit = () => {
  throw Object.assign(new Error("unknown Worker"), {
    code: "authentication_failed",
  });
};

Deno.test("portable Hypervisor prepares only its declared WebSocket paths", async () => {
  const websocket = {
    type: "websocket",
    config: { path },
  } as const satisfies HypervisorTransport;
  const hypervisor = createHypervisor({
    transports: [websocket],
    admit: rejectUnknownWorker,
    fallback: () => new Response("fallback", { status: 202 }),
  });

  const fallback = hypervisor.prepare(
    new Request("https://example.test/not-a-worker"),
  );
  if (fallback.kind !== "response") {
    throw new Error("expected a normal HTTP response decision");
  }
  const response = await fallback.response;
  assertEquals(response.status, 202);
  assertEquals(await response.text(), "fallback");

  const admission = hypervisor.prepare(
    new Request(`https://example.test${path}`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "oxian.worker.v1",
      },
    }),
  );
  if (admission.kind !== "upgrade") {
    throw new Error("expected a WebSocket upgrade decision");
  }
  assertEquals(admission.protocol, "oxian.worker.v1");
  assertEquals(hypervisor.snapshot().connections, 1);
  admission.cancel("test_upgrade_failure");
  assertEquals(hypervisor.snapshot().connections, 0);
  await hypervisor.shutdown();
});

Deno.test("Hypervisor accepts plain admission and lifecycle functions", async () => {
  let assigned = false;
  const hypervisor = createHypervisor(
    {
      transports: [{
        type: "in-process",
        config: { topic: `types-${crypto.randomUUID()}` },
      }],
      admit: rejectUnknownWorker,
    },
    {
      onWorkAssigned() {
        assigned = true;
      },
    },
  );
  assertEquals(hypervisor.snapshot().connections, 0);
  assertEquals(assigned, false);
  await hypervisor.shutdown();
});

Deno.test("Hypervisor validates declarative transports and functions", () => {
  assertThrows(
    () => createHypervisor({ transports: [] }),
    TypeError,
    "at least one",
  );
  assertThrows(
    () =>
      createHypervisor({
        transports: [{
          type: "websocket",
          config: { path: "relative" },
        }],
        admit: rejectUnknownWorker,
      }),
    TypeError,
    "config.path",
  );
  assertThrows(
    () =>
      createHypervisor({
        transports: [{
          type: "websocket",
          config: { path },
        }],
      }),
    TypeError,
    "admit",
  );
  assertThrows(
    () =>
      createHypervisor({
        transports: [
          { type: "in-process", config: { topic: "duplicate" } },
          { type: "in-process", config: { topic: "duplicate" } },
        ],
      }),
    TypeError,
    "unique",
  );
  assertThrows(
    () =>
      createHypervisor(
        {
          transports: [{
            type: "in-process",
            config: { topic: `callback-${crypto.randomUUID()}` },
          }],
        },
        { onReady: 42 } as never,
      ),
    TypeError,
    "onReady",
  );
});
