import assert from "node:assert/strict";
import { connect as connectTcp } from "node:net";
import { test } from "node:test";
import { serve } from "../../src/adapters/node/server.ts";
import {
  CONNECTION_BUDGET,
  createOwnerHost,
  createShardMap,
} from "../../src/host/index.ts";
import { createHypervisor } from "../../src/hypervisor/hypervisor.ts";
import { createMemoryOwnerStore } from "../../src/owner/memory.ts";
import { createOwner } from "../../src/owner/owner.ts";
import { isOwnerError } from "../../src/owner/primitives.ts";
import type { Owner } from "../../src/owner/types.ts";

test("a shard that does not own an id does not move its epoch", async () => {
  const owners = { "owner-1": "a" };
  const here = createOwnerHost({ map: createShardMap("a", owners) });
  const elsewhere = createOwnerHost({ map: createShardMap("b", owners) });
  const store = createMemoryOwnerStore();
  let started = 0;
  const owner = here.open("owner-1", () => {
    started += 1;
    return createOwner({
      store,
      commands: { ping: () => ({ ok: true }) },
    });
  });
  await owner.ready;
  assert.throws(
    () =>
      elsewhere.open("owner-1", () => {
        started += 1;
        return createOwner({ store, commands: { ping: () => ({ ok: true }) } });
      }),
    (error: unknown) => isOwnerError(error, "ownership_lost"),
  );
  assert.equal(started, 1);
  assert.equal(owner.snapshot().epoch, 1);
  assert.deepStrictEqual(
    await owner.submit({
      type: "ping",
      identity: { domain: "logical", key: "once" },
      input: null,
    }),
    { status: "committed", result: { ok: true } },
  );
  await owner.stop();
});

test("one process runs every owner assigned to it", async () => {
  const host = createOwnerHost({
    map: createShardMap("local", { one: "local", two: "local" }),
  });
  const first = openOwner(host, "one");
  const second = openOwner(host, "two");
  assert.equal(
    host.open("one", () => assert.fail("started again")),
    first,
  );
  await first.ready;
  await second.ready;
  assert.deepStrictEqual(host.snapshot().owners, ["one", "two"]);
  await first.stop();
  await second.stop();
  host.close();
});

test("the connection budget refuses the next connection", () => {
  const host = createOwnerHost({
    map: createShardMap("local", {}),
    maxConnections: 2,
  });
  const first = host.connect();
  host.connect();
  assert.throws(() => host.connect(), /connection budget exceeded/);
  first.release();
  const third = host.connect();
  third.release();
  third.release();
  assert.equal(host.snapshot().connections, 1);
  assert.throws(
    () =>
      createOwnerHost({ map: host.map, maxConnections: CONNECTION_BUDGET + 1 }),
    RangeError,
  );
});

test("the node listener refuses an upgrade past the budget", async () => {
  const host = createOwnerHost({
    map: createShardMap("local", {}),
    maxConnections: 1,
  });
  const hypervisor = createHypervisor({
    transports: [
      {
        type: "in-process",
        config: { topic: `budget-${crypto.randomUUID()}` },
      },
    ],
  });
  const listener = await serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
    budget: host,
  });
  host.connect();
  const refused = await openUpgrade(listener.port);
  assert.equal(await readStatus(refused), 503);
  refused.destroy();
  await listener.shutdown();
  await hypervisor.shutdown("budget_test");
});

function openOwner(
  host: ReturnType<typeof createOwnerHost>,
  ownerId: string,
): Owner {
  return host.open(ownerId, () =>
    createOwner({
      store: createMemoryOwnerStore(),
      commands: {
        ping: () => ({ ok: true }),
      },
    }),
  );
}

function openUpgrade(port: number): Promise<ReturnType<typeof connectTcp>> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function readStatus(socket: ReturnType<typeof connectTcp>): Promise<number> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("no status")), 2_000);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const status = /^HTTP\/1\.1 (\d+)/.exec(text);
      if (status?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(status[1]));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
