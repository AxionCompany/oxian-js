import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTables } from "../../src/owner/memory.ts";
import { createMemoryOwnerStore } from "../../src/owner/memory.ts";
import { createOwner } from "../../src/owner/owner.ts";
import { isOwnerError } from "../../src/owner/primitives.ts";
import {
  createCommandSession,
  createSnapshotSession,
} from "../../src/owner/remote.ts";
import type { CommandRequest } from "../../src/owner/types.ts";

test("an old session cannot mutate after takeover and can still read receipts", async () => {
  const store = createMemoryOwnerStore();
  let runs = 0;
  const commands = {
    put: (tx: MemoryTables, input: CommandRequest["input"]) => {
      runs += 1;
      const value = input as { n: number };
      tx.put("rows", "a", value);
      return value;
    },
  };
  const first = createOwner({ store, commands });
  await first.ready;
  const session = createCommandSession({
    owner: first,
    ownerId: "owner-1",
    connectionId: "c1",
  });
  assert.equal(session.identity.ownerEpoch, 1);
  assert.deepStrictEqual(await session.submit(command({ n: 1 })), {
    status: "committed",
    result: { n: 1 },
  });

  const successor = createOwner({ store, commands });
  await successor.ready;
  assert.deepStrictEqual(await session.submit(command({ n: 2 })), {
    status: "ownership_lost",
  });
  assert.equal(runs, 1);
  assert.deepStrictEqual(
    (await session.lookupReceipt({ domain: "logical", key: "a" }))?.result,
    { n: 1 },
  );
  await successor.stop();
});

test("a snapshot stays on the state it opened and closes on every path", async () => {
  const store = createMemoryOwnerStore();
  const owner = createOwner({
    store,
    commands: {
      put: (tx, input) => {
        tx.put("rows", "a", input);
        return input;
      },
    },
  });
  await owner.ready;
  await owner.submit(command({ n: 1 }));
  let now = 0;
  const snapshot = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "snap",
    clock: () => now,
    idleMs: 30,
    lifetimeMs: 100,
  });
  assert.deepStrictEqual(await snapshot.read((tx) => tx.get("rows", "a")), {
    n: 1,
  });
  await owner.submit(command({ n: 2 }, "b"));
  assert.deepStrictEqual(await snapshot.read((tx) => tx.get("rows", "a")), {
    n: 1,
  });

  now = 30;
  await assert.rejects(
    snapshot.read((tx) => tx.get("rows", "a")),
    /snapshot expired/,
  );
  await snapshot.close();
  await assert.rejects(
    snapshot.read((tx) => tx.get("rows", "a")),
    /snapshot closed/,
  );
  await owner.stop();
});

test("a snapshot fails when its signal aborts, its lifetime ends, or the owner is taken", async () => {
  const store = createMemoryOwnerStore();
  const owner = createOwner({ store, commands: { put: () => ({ ok: true }) } });
  await owner.ready;
  const signal = new AbortController();
  let now = 0;
  const cancelled = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "cancel",
    signal: signal.signal,
    clock: () => now,
  });
  signal.abort();
  await assert.rejects(
    cancelled.read(() => null),
    /snapshot closed|snapshot cancelled/,
  );

  now = 0;
  const aged = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "life",
    clock: () => now,
    idleMs: 1_000,
    lifetimeMs: 50,
  });
  now = 10;
  assert.equal(await aged.read(() => "fresh"), "fresh");
  now = 50;
  await assert.rejects(
    aged.read(() => "late"),
    /snapshot expired/,
  );

  const live = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "takeover",
    clock: () => 0,
  });
  const successor = createOwner({
    store,
    commands: { put: () => ({ ok: true }) },
  });
  await successor.ready;
  await live
    .read(() => null)
    .then(
      () => assert.fail("old snapshot read"),
      (error: unknown) =>
        assert.equal(isOwnerError(error, "ownership_lost"), true),
    );
  await successor.stop();
});

test("a pending snapshot read fails when the session expires or is cancelled", async () => {
  const store = createMemoryOwnerStore();
  const owner = createOwner({ store, commands: {} });
  await owner.ready;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const expiring = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "pending",
    lifetimeMs: 40,
    idleMs: 1_000,
  });
  await assert.rejects(
    expiring.read(async () => {
      await gate;
      return "late";
    }),
    /snapshot expired/,
  );

  const signal = new AbortController();
  const cancelled = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "wired",
    signal: signal.signal,
    lifetimeMs: 60_000,
  });
  const pending = cancelled.read(async () => {
    await gate;
    return "late";
  });
  signal.abort();
  await assert.rejects(pending, /snapshot cancelled/);
  release?.();
  await owner.stop();
});

test("an epoch check failure closes the snapshot", async () => {
  const inner = createMemoryOwnerStore();
  const owner = createOwner({ store: inner, commands: {} });
  await owner.ready;
  let fail = false;
  const store = {
    ...inner,
    readEpoch() {
      if (fail) return Promise.reject(new Error("epoch unavailable"));
      return inner.readEpoch();
    },
  };
  const snapshot = await createSnapshotSession({
    owner,
    store,
    ownerId: "owner-1",
    connectionId: "epoch-error",
  });
  fail = true;
  await assert.rejects(
    snapshot.read(() => "value"),
    /epoch unavailable/,
  );
  await assert.rejects(
    snapshot.read(() => "value"),
    /snapshot closed/,
  );
  await owner.stop();
});

function command(input: CommandRequest["input"], key = "a"): CommandRequest {
  return { type: "put", identity: { domain: "logical", key }, input };
}
