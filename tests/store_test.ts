/**
 * Unit tests for the MemoryStore implementation.
 *
 * Covers all HypervisorStore interface methods: key-value, counters,
 * locks, and request-response queue operations.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { MemoryStore } from "../src/hypervisor/store.ts";

// ---------------------------------------------------------------------------
// Key-value
// ---------------------------------------------------------------------------

Deno.test("store get: returns undefined for missing key", async () => {
  const store = new MemoryStore();
  assertEquals(await store.get("missing"), undefined);
});

Deno.test("store set/get: stores and retrieves value", async () => {
  const store = new MemoryStore();
  await store.set("key", "value");
  assertEquals(await store.get("key"), "value");
});

Deno.test("store set/get: stores complex objects", async () => {
  const store = new MemoryStore();
  const obj = { service: "api", port: 8080, nested: { x: 1 } };
  await store.set("config", obj);
  assertEquals(await store.get("config"), obj);
});

Deno.test("store set: overwrites existing value", async () => {
  const store = new MemoryStore();
  await store.set("key", "v1");
  await store.set("key", "v2");
  assertEquals(await store.get("key"), "v2");
});

Deno.test("store delete: removes key", async () => {
  const store = new MemoryStore();
  await store.set("key", "value");
  await store.delete("key");
  assertEquals(await store.get("key"), undefined);
});

Deno.test("store delete: no-op for missing key", async () => {
  const store = new MemoryStore();
  await store.delete("missing"); // should not throw
});

Deno.test({
  name: "store set: TTL expires value",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  await store.set("key", "value", 50); // 50ms TTL
  assertEquals(await store.get("key"), "value");
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(await store.get("key"), undefined);
});

Deno.test("store set: no TTL means value persists", async () => {
  const store = new MemoryStore();
  await store.set("key", "value");
  assertEquals(await store.get("key"), "value");
});

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

Deno.test("store increment: starts from 0", async () => {
  const store = new MemoryStore();
  assertEquals(await store.increment("counter"), 1);
});

Deno.test("store increment: increments existing", async () => {
  const store = new MemoryStore();
  await store.increment("counter");
  await store.increment("counter");
  assertEquals(await store.increment("counter"), 3);
});

Deno.test("store decrement: starts from 0, stays at 0", async () => {
  const store = new MemoryStore();
  assertEquals(await store.decrement("counter"), 0);
});

Deno.test("store decrement: decrements existing", async () => {
  const store = new MemoryStore();
  await store.increment("counter");
  await store.increment("counter");
  await store.increment("counter");
  assertEquals(await store.decrement("counter"), 2);
});

Deno.test("store decrement: clamps to 0", async () => {
  const store = new MemoryStore();
  await store.increment("counter");
  await store.decrement("counter");
  assertEquals(await store.decrement("counter"), 0);
});

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

Deno.test("store acquire: succeeds on first acquire", async () => {
  const store = new MemoryStore();
  assertEquals(await store.acquire("lock", 5000), true);
});

Deno.test("store acquire: fails if already acquired", async () => {
  const store = new MemoryStore();
  assertEquals(await store.acquire("lock", 5000), true);
  assertEquals(await store.acquire("lock", 5000), false);
});

Deno.test("store release: allows re-acquire", async () => {
  const store = new MemoryStore();
  await store.acquire("lock", 5000);
  await store.release("lock");
  assertEquals(await store.acquire("lock", 5000), true);
});

Deno.test("store release: no-op for unheld lock", async () => {
  const store = new MemoryStore();
  await store.release("lock"); // should not throw
});

Deno.test("store acquire: independent locks don't interfere", async () => {
  const store = new MemoryStore();
  assertEquals(await store.acquire("lock-a", 5000), true);
  assertEquals(await store.acquire("lock-b", 5000), true);
});

// ---------------------------------------------------------------------------
// Queue: enqueue / drain
// ---------------------------------------------------------------------------

Deno.test("store enqueue: returns unique IDs", async () => {
  const store = new MemoryStore();
  const id1 = await store.enqueue("q", "item1");
  const id2 = await store.enqueue("q", "item2");
  assertEquals(id1 !== id2, true);
});

Deno.test("store drain: returns all enqueued items", async () => {
  const store = new MemoryStore();
  const id1 = await store.enqueue("q", "a");
  const id2 = await store.enqueue("q", "b");
  const items = await store.drain<string>("q");
  assertEquals(items.length, 2);
  assertEquals(items[0], { id: id1, item: "a" });
  assertEquals(items[1], { id: id2, item: "b" });
});

Deno.test("store drain: clears the queue", async () => {
  const store = new MemoryStore();
  await store.enqueue("q", "item");
  await store.drain("q");
  const items = await store.drain("q");
  assertEquals(items.length, 0);
});

Deno.test("store drain: empty queue returns empty array", async () => {
  const store = new MemoryStore();
  assertEquals(await store.drain("q"), []);
});

Deno.test("store enqueue: independent queues don't mix", async () => {
  const store = new MemoryStore();
  await store.enqueue("q1", "a");
  await store.enqueue("q2", "b");
  const items1 = await store.drain<string>("q1");
  const items2 = await store.drain<string>("q2");
  assertEquals(items1.length, 1);
  assertEquals(items1[0].item, "a");
  assertEquals(items2.length, 1);
  assertEquals(items2[0].item, "b");
});

// ---------------------------------------------------------------------------
// Queue: waitFor / resolve
// ---------------------------------------------------------------------------

Deno.test({
  name: "store waitFor/resolve: resolve unblocks waiter",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const promise = store.waitFor<string>("req-1");
  // Resolve after a short delay
  setTimeout(() => store.resolve("req-1", "response"), 10);
  const result = await promise;
  assertEquals(result, "response");
});

Deno.test({
  name: "store waitFor: timeout rejects",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  let rejected = false;
  try {
    await store.waitFor("req-1", 50);
  } catch (e) {
    rejected = true;
    assertEquals((e as Error).message, "waitFor timeout");
  }
  assertEquals(rejected, true);
});

Deno.test({
  name: "store resolve: no-op if no waiter",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  // Should not throw
  await store.resolve("nonexistent", "value");
});

Deno.test({
  name: "store waitFor/resolve: multiple independent correlations",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();
  const p1 = store.waitFor<string>("a");
  const p2 = store.waitFor<string>("b");
  // Resolve in reverse order
  setTimeout(() => store.resolve("b", "second"), 10);
  setTimeout(() => store.resolve("a", "first"), 20);
  assertEquals(await p2, "second");
  assertEquals(await p1, "first");
});

// ---------------------------------------------------------------------------
// Queue: full enqueue → waitFor → drain → resolve flow
// ---------------------------------------------------------------------------

Deno.test({
  name: "store: full request-response queue flow",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const store = new MemoryStore();

  // Caller side: enqueue and wait
  const id = await store.enqueue("svc:api", { method: "GET", url: "/test" });
  const responsePromise = store.waitFor<{ status: number }>(id);

  // Owner side: drain and resolve
  setTimeout(async () => {
    const pending = await store.drain<{ method: string; url: string }>("svc:api");
    for (const { id, item } of pending) {
      // "Process" the request
      assertEquals(item.method, "GET");
      assertEquals(item.url, "/test");
      await store.resolve(id, { status: 200 });
    }
  }, 10);

  const response = await responsePromise;
  assertEquals(response.status, 200);
});
