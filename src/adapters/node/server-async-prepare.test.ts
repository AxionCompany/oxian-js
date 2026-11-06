import assert from "node:assert/strict";
import { connect as connectTcp, type Socket } from "node:net";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import type {
  HypervisorHost,
  HypervisorRequestDecision,
} from "../../hypervisor/types.ts";
import type { SocketConnection } from "../../transport/types.ts";
import { createConnectionBudget } from "./connection-budget.ts";
import { serve } from "./server.ts";

const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function front(prepare: HypervisorHost["prepare"]) {
  const hypervisor = createHypervisor({
    transports: [
      { type: "in-process", config: { topic: crypto.randomUUID() } },
    ],
  });
  const host: HypervisorHost = { ...hypervisor, prepare };
  return { hypervisor, host };
}

/** A handshake request, optionally followed at once by one masked "hi" frame. */
function handshake(early: boolean): Buffer {
  const head =
    "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n" +
    `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${KEY}\r\n` +
    "Sec-WebSocket-Protocol: test.v1\r\n\r\n";
  const frame = Buffer.from([0x81, 0x82, 0, 0, 0, 0, 0x68, 0x69]);
  return early ? Buffer.concat([Buffer.from(head), frame]) : Buffer.from(head);
}

function client(port: number, early: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(handshake(early));
      resolve(socket);
    });
  });
}

test("Node upgrade awaits an async prepare, attaches, and keeps head bytes", {
  timeout: 5_000,
}, async () => {
  const received = Promise.withResolvers<string>();
  const attached: string[] = [];
  const { hypervisor, host } = front(async () => {
    await delay(50);
    return {
      kind: "upgrade",
      protocol: "test.v1",
      attach(connection: SocketConnection) {
        attached.push(connection.protocol);
        connection.subscribe({
          message: (data) => received.resolve(String(data)),
        });
      },
      cancel: () => assert.fail("must not cancel"),
    };
  });
  const budget = createConnectionBudget();
  const listener = await serve({ hypervisor: host, budget });
  const socket = await client(listener.port, true);
  try {
    assert.equal(await received.promise, "hi");
    assert.deepEqual(attached, ["test.v1"]);
  } finally {
    socket.destroy();
    await listener.shutdown();
    await hypervisor.shutdown();
  }
});

test("Node upgrade cancels, never attaches, when the socket closes during prepare", {
  timeout: 5_000,
}, async () => {
  const gate = Promise.withResolvers<HypervisorRequestDecision>();
  const entered = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<string | undefined>();
  let attaches = 0;
  const { hypervisor, host } = front(() => {
    entered.resolve();
    return gate.promise;
  });
  const budget = createConnectionBudget();
  const listener = await serve({ hypervisor: host, budget });
  const socket = await client(listener.port, false);
  try {
    await entered.promise;
    socket.destroy();
    await delay(50);
    gate.resolve({
      kind: "upgrade",
      protocol: "test.v1",
      attach: () => {
        attaches++;
      },
      cancel: (reason) => cancelled.resolve(reason),
    });
    assert.equal(await cancelled.promise, "upgrade_closed");
    assert.equal(attaches, 0);
    // The connection budget was released: a fresh upgrade is not refused.
    const again = await client(listener.port, false);
    again.destroy();
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown();
  }
});

test("Node upgrade closes the socket when an async prepare rejects", {
  timeout: 5_000,
}, async () => {
  const { hypervisor, host } = front(async () => {
    await delay(10);
    throw new Error("no runtime");
  });
  const listener = await serve({ hypervisor: host });
  const socket = await client(listener.port, false);
  try {
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown();
  }
});

test("Node plain requests await an async prepare", {
  timeout: 5_000,
}, async () => {
  const { hypervisor, host } = front(async (request) => {
    await delay(50);
    return {
      kind: "response",
      response: new Response(`late ${new URL(request.url).pathname}`),
    };
  });
  const listener = await serve({ hypervisor: host });
  try {
    const response = await fetch(new URL("/a", listener.url));
    assert.equal(await response.text(), "late /a");
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown();
  }
});
