import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryOwnerStore,
  type MemoryTables,
} from "../../src/owner/memory.ts";
import { createOwner } from "../../src/owner/owner.ts";
import type {
  CommandHandler,
  CommandRequest,
  IdentityDomain,
  OwnerStore,
} from "../../src/owner/types.ts";

test("a failed command and a duplicate consume no sequence", async () => {
  const store = createMemoryOwnerStore();
  const owner = createOwner({
    store,
    commands: {
      publish: async (_tx, input, context) => {
        const value = input as { n?: number; fail?: boolean };
        const seq = await context.append({ n: value.n ?? 0 });
        if (value.fail) return context.conflict("no");
        return { seq };
      },
    },
  });
  await owner.ready;
  assert.deepStrictEqual(await owner.submit(change("one", { n: 1 })), {
    status: "committed",
    result: { seq: 1 },
  });
  assert.deepStrictEqual(await owner.submit(change("bad", { fail: true })), {
    status: "conflict",
    reason: "no",
  });
  assert.deepStrictEqual(await owner.submit(change("two", { n: 2 })), {
    status: "committed",
    result: { seq: 2 },
  });
  assert.deepStrictEqual(await owner.submit(change("one", { n: 1 })), {
    status: "duplicate",
    result: { seq: 1 },
  });
  assert.deepStrictEqual(await owner.heartbeat(), { head: 2 });
  await owner.stop();
});

test("a rolled-back group consumes no sequence", async () => {
  const inner = createMemoryOwnerStore();
  let fail = true;
  const store: OwnerStore<MemoryTables> = {
    acquire: () => inner.acquire(),
    readReceipt: (identity) => inner.readReceipt(identity),
    readHead: () => inner.readHead(),
    readAlarm: () => inner.readAlarm(),
    beginSnapshot: () => inner.beginSnapshot(),
    readEpoch: () => inner.readEpoch(),
    async begin(epoch) {
      const transaction = await inner.begin(epoch);
      return {
        ...transaction,
        async commit() {
          if (fail) {
            fail = false;
            await transaction.rollback();
            throw new Error("aborted");
          }
          await transaction.commit();
        },
      };
    },
  };
  const owner = createOwner({
    store,
    commands: {
      publish: async (_tx, _input, context) => {
        const seq = await context.append({ n: 1 });
        return { seq };
      },
    },
  });
  await owner.ready;
  assert.deepStrictEqual(await owner.submit(change("one", { n: 1 })), {
    status: "committed",
    result: { seq: 1 },
  });
  assert.deepStrictEqual(await inner.readHead(), 1);
  await owner.stop();
});

test("attach captures the head of its commit", async () => {
  const store = createMemoryOwnerStore();
  let releaseAcquire!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseAcquire = resolve;
  });
  const owner = createOwner({
    store: {
      acquire: async () => {
        await hold;
        return await store.acquire();
      },
      begin: (epoch) => store.begin(epoch),
      readReceipt: (identity) => store.readReceipt(identity),
      readHead: () => store.readHead(),
      readAlarm: () => store.readAlarm(),
      beginSnapshot: () => store.beginSnapshot(),
      readEpoch: () => store.readEpoch(),
    },
    commands: {
      publish: async (_tx, input, context) => {
        const seq = await context.append(input);
        return { seq };
      },
    },
  });
  const published = owner.submit(change("one", { n: 1 }));
  const attached = owner.attach("device");
  releaseAcquire();
  assert.deepStrictEqual(await published, {
    status: "committed",
    result: { seq: 1 },
  });
  assert.deepStrictEqual(await attached, { cursor: 1 });
  assert.deepStrictEqual(owner.observer("device"), {
    cursor: 1,
    applied: 1,
    reset: false,
  });
  await owner.stop();
});

test("a heartbeat head shows a dropped last update", async () => {
  const { owner } = await publisher();
  assert.deepStrictEqual(await owner.attach("device"), { cursor: 0 });
  await owner.submit(change("one", { n: 1 }));
  await owner.submit(change("two", { n: 2 }));
  await owner.submit(change("three", { n: 3 }));
  owner.acknowledge("device", 2);
  assert.deepStrictEqual(await owner.heartbeat(), { head: 3 });
  assert.equal(owner.observer("device")?.applied, 2);
  await owner.stop();
});

test("a dropped push resets that observer", async () => {
  const { owner } = await publisher();
  await owner.submit(change("one", { n: 1 }));
  await owner.attach("device");
  owner.acknowledge("device", 1);
  owner.resetObserver("device");
  owner.acknowledge("device", 1);
  assert.deepStrictEqual(owner.observer("device"), {
    cursor: 1,
    applied: undefined,
    reset: true,
  });
  assert.deepStrictEqual(await owner.attach("device"), { cursor: 1 });
  assert.equal(owner.observer("device")?.reset, false);
  await owner.stop();
});

test("an alarm wakes the owner that takes over", async () => {
  const store = createMemoryOwnerStore();
  const fires: number[] = [];
  let now = 1_000;
  const commands: Record<string, CommandHandler<MemoryTables>> = {
    arm: async (_tx, input, context) => {
      await context.setAlarm((input as { at: number }).at);
      return input;
    },
  };
  const options = {
    store,
    commands,
    clock: () => now,
    onAlarm: (at: number) => {
      fires.push(at);
    },
    scheduleAlarm: () => () => undefined,
  };
  const first = createOwner(options);
  await first.ready;
  await first.submit({
    type: "arm",
    identity: { domain: "occurrence", key: "wake" },
    input: { at: 5_000 },
  });
  await first.stop();
  assert.deepStrictEqual(fires, []);

  now = 5_000;
  const successor = createOwner(options);
  await successor.ready;
  await waitFor(() => fires.length === 1);
  assert.deepStrictEqual(fires, [5_000]);
  await successor.stop();
});

test("an early timer waits for the alarm instead of firing", async () => {
  const store = createMemoryOwnerStore();
  const fires: number[] = [];
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const owner = createOwner({
    store,
    clock: () => now,
    onAlarm: (at) => {
      fires.push(at);
    },
    scheduleAlarm(at, run) {
      const timer = { at, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    commands: {
      arm: async (_tx, input, context) => {
        await context.setAlarm((input as { at: number }).at);
        return input;
      },
    },
  });
  await owner.ready;
  await owner.submit({
    type: "arm",
    identity: { domain: "occurrence", key: "early" },
    input: { at: 5_000 },
  });
  await waitFor(() => timers.length === 1);
  timers[0]?.run();
  await waitFor(() => timers.some((timer) => timer.at === 5_000));
  assert.deepStrictEqual(fires, []);
  now = 5_000;
  timers.find((timer) => timer.at === 5_000)?.run();
  assert.deepStrictEqual(fires, [5_000]);
  await owner.stop();
});

test("a failed alarm read is tried again", async () => {
  const inner = createMemoryOwnerStore();
  const seeded = createOwner({
    store: inner,
    clock: () => 0,
    scheduleAlarm: () => () => undefined,
    commands: {
      arm: async (_tx, input, context) => {
        await context.setAlarm((input as { at: number }).at);
        return input;
      },
    },
  });
  await seeded.ready;
  await seeded.submit({
    type: "arm",
    identity: { domain: "occurrence", key: "due" },
    input: { at: 0 },
  });
  await seeded.stop();

  let fail = true;
  const fires: number[] = [];
  const timers: { at: number; run: () => void }[] = [];
  const owner = createOwner({
    store: {
      acquire: () => inner.acquire(),
      begin: (epoch) => inner.begin(epoch),
      readReceipt: (identity) => inner.readReceipt(identity),
      readHead: () => inner.readHead(),
      readAlarm: () => {
        if (fail) {
          fail = false;
          return Promise.reject(new Error("transient"));
        }
        return inner.readAlarm();
      },
      beginSnapshot: () => inner.beginSnapshot(),
      readEpoch: () => inner.readEpoch(),
    },
    clock: () => 0,
    onError: () => undefined,
    onAlarm: (at) => {
      fires.push(at);
    },
    scheduleAlarm(at, run) {
      const timer = { at, run };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    commands: { arm: () => null },
  });
  await owner.ready;
  await waitFor(() => timers.length === 1);
  assert.deepStrictEqual(fires, []);
  timers[0]?.run();
  await waitFor(() => fires.length === 1);
  assert.deepStrictEqual(fires, [0]);
  await owner.stop();
});

test("a failed command does not leave an alarm", async () => {
  const store = createMemoryOwnerStore();
  const fires: number[] = [];
  const owner = createOwner({
    store,
    clock: () => 5_000,
    onAlarm: (at) => {
      fires.push(at);
    },
    commands: {
      arm: async (_tx, _input, context) => {
        await context.setAlarm(1_000);
        return context.conflict("no");
      },
    },
  });
  await owner.ready;
  assert.deepStrictEqual(
    await owner.submit({
      type: "arm",
      identity: { domain: "occurrence", key: "wake" },
      input: null,
    }),
    { status: "conflict", reason: "no" },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepStrictEqual(fires, []);
  assert.equal(await store.readAlarm(), undefined);
  await owner.stop();
});

async function publisher(): Promise<{
  owner: ReturnType<typeof createOwner<MemoryTables>>;
}> {
  const owner = createOwner({
    store: createMemoryOwnerStore(),
    commands: {
      publish: async (_tx, input, context) => ({
        seq: await context.append(input),
      }),
    },
  });
  await owner.ready;
  return { owner };
}

function change(
  key: string,
  input: CommandRequest["input"],
  domain: IdentityDomain = "logical",
): CommandRequest {
  return { type: "publish", identity: { domain, key }, input };
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
