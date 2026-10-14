import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMemoryOwnerStore,
  type MemoryTables,
} from "../../src/owner/memory.ts";
import { createOwner } from "../../src/owner/owner.ts";
import { createOwnerError } from "../../src/owner/primitives.ts";
import type {
  CommandHandler,
  CommandRequest,
  IdentityDomain,
  Owner,
  OwnerOptions,
  OwnerStore,
} from "../../src/owner/types.ts";

function request(
  type: string,
  domain: IdentityDomain,
  key: string,
  input: CommandRequest["input"] = null,
): CommandRequest {
  return { type, identity: { domain, key }, input };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function started(
  commands: OwnerOptions<MemoryTables>["commands"],
  options: Partial<Omit<OwnerOptions<MemoryTables>, "commands">> & {
    holdReady?: Promise<void>;
  } = {},
): Promise<{ owner: Owner; store: OwnerStore<MemoryTables> }> {
  const store = options.store ?? createMemoryOwnerStore();
  const owner = createOwner({
    ...options,
    store:
      options.holdReady === undefined
        ? store
        : {
            acquire: async () => {
              await options.holdReady;
              return await store.acquire();
            },
            begin: (epoch) => store.begin(epoch),
            readReceipt: (identity) => store.readReceipt(identity),
          },
    commands,
  });
  if (options.holdReady === undefined) await owner.ready;
  return { owner, store };
}

test("a committed command returns its result and keeps its receipt", async () => {
  const store = createMemoryOwnerStore();
  const { owner } = await started(
    {
      put: (tx, input) => {
        tx.put("rows", "a", input);
        return input;
      },
    },
    { store },
  );

  const outcome = await owner.submit(request("put", "logical", "a", { n: 1 }));

  assert.deepStrictEqual(outcome, { status: "committed", result: { n: 1 } });
  assert.deepStrictEqual(await store.read("rows", "a"), { n: 1 });
  const receipt = await owner.lookupReceipt({ domain: "logical", key: "a" });
  assert.equal(receipt?.result && JSON.stringify(receipt.result), '{"n":1}');
  await owner.stop();
});

test("the same request returns its receipt; a different request is rejected", async () => {
  const { owner } = await started({
    put: (_tx, input) => input,
  });

  const first = await owner.submit(
    request("put", "logical", "step", { a: 1, b: 2 }),
  );
  const reordered = await owner.submit(
    request("put", "logical", "step", { b: 2, a: 1 }),
  );
  const conflicting = await owner.submit(
    request("put", "logical", "step", { a: 2 }),
  );

  assert.deepStrictEqual(first, {
    status: "committed",
    result: { a: 1, b: 2 },
  });
  assert.deepStrictEqual(reordered, {
    status: "duplicate",
    result: { a: 1, b: 2 },
  });
  assert.deepStrictEqual(conflicting, {
    status: "invalid",
    reason: "identity already used by a different request",
  });
  await owner.stop();
});

test("identity domains do not share receipts", async () => {
  const runs: string[] = [];
  const { owner } = await started({
    note: (_tx, _input, context) => {
      runs.push(`${context.identity.domain}:${context.identity.key}`);
      return runs.length;
    },
  });

  const logical = await owner.submit(request("note", "logical", "step"));
  const again = await owner.submit(request("note", "logical", "step"));
  const incarnation = await owner.submit(
    request("note", "incarnation", "step"),
  );
  const beat = await owner.submit(request("note", "occurrence", "beat:1"));
  const alarm = await owner.submit(request("note", "occurrence", "alarm:1"));

  assert.deepStrictEqual(logical, { status: "committed", result: 1 });
  assert.deepStrictEqual(again, { status: "duplicate", result: 1 });
  assert.deepStrictEqual(incarnation, { status: "committed", result: 2 });
  assert.deepStrictEqual(beat, { status: "committed", result: 3 });
  assert.deepStrictEqual(alarm, { status: "committed", result: 4 });
  assert.deepStrictEqual(runs, [
    "logical:step",
    "incarnation:step",
    "occurrence:beat:1",
    "occurrence:alarm:1",
  ]);
  await owner.stop();
});

test("one failing command rolls back only itself", async () => {
  const store = createMemoryOwnerStore();
  const { owner } = await started(
    {
      put: (tx, input, context) => {
        const value = input as { fail?: boolean };
        tx.put("rows", context.identity.key, { ok: true });
        if (value.fail) context.conflict("lease_expired");
        return { ok: true };
      },
    },
    { store },
  );

  const [kept, failed] = await Promise.all([
    owner.submit(request("put", "logical", "kept", {})),
    owner.submit(request("put", "logical", "failed", { fail: true })),
  ]);

  assert.deepStrictEqual(kept, { status: "committed", result: { ok: true } });
  assert.deepStrictEqual(failed, {
    status: "conflict",
    reason: "lease_expired",
  });
  assert.deepStrictEqual(await store.read("rows", "kept"), { ok: true });
  assert.equal(await store.read("rows", "failed"), undefined);
  await owner.stop();
});

test("a thrown command rolls back its writes and keeps the rest of the group", async () => {
  const store = createMemoryOwnerStore();
  const { owner } = await started(
    {
      put: (tx, input, context) => {
        tx.put("rows", context.identity.key, { ok: true });
        if ((input as { fail?: boolean }).fail) throw new Error("boom");
        return { ok: true };
      },
    },
    { store },
  );

  const [kept, failed] = await Promise.allSettled([
    owner.submit(request("put", "logical", "kept", {})),
    owner.submit(request("put", "logical", "failed", { fail: true })),
  ]);

  assert.equal(kept.status, "fulfilled");
  assert.equal(failed.status, "rejected");
  assert.deepStrictEqual(await store.read("rows", "kept"), { ok: true });
  assert.equal(await store.read("rows", "failed"), undefined);
  await owner.stop();
});

test("a lease crossed inside a group fails only the later command", async () => {
  const store = createMemoryOwnerStore();
  let time = 0;
  const hold = deferred();
  const { owner } = await started(
    {
      check: (tx, input, context) => {
        const deadline = (input as { deadline: number }).deadline;
        if (context.now > deadline) context.conflict("lease_expired");
        tx.put("rows", context.identity.key, context.now);
        return context.now;
      },
    },
    {
      store,
      clock: () => (time += 1_000),
      holdReady: hold.promise,
    },
  );

  const early = owner.submit(
    request("check", "logical", "early", { deadline: 1_500 }),
  );
  const late = owner.submit(
    request("check", "logical", "late", { deadline: 1_500 }),
  );
  hold.resolve();
  await owner.ready;

  assert.deepStrictEqual(await early, { status: "committed", result: 1_000 });
  assert.deepStrictEqual(await late, {
    status: "conflict",
    reason: "lease_expired",
  });
  assert.equal(await store.read("rows", "late"), undefined);
  await owner.stop();
});

test("a lost commit stops the owner and the successor trusts receipts", async () => {
  const inner = createMemoryOwnerStore();
  let lost = true;
  const callbacks: string[] = [];
  const runs: string[] = [];
  const commands: Record<string, CommandHandler<MemoryTables>> = {
    put: (tx, _input, context) => {
      runs.push(context.identity.key);
      tx.put("rows", context.identity.key, { ok: true });
      context.afterCommit(() => {
        callbacks.push(context.identity.key);
      });
      return { ok: true };
    },
  };
  const store: OwnerStore<MemoryTables> = {
    acquire: () => inner.acquire(),
    readReceipt: (identity) => inner.readReceipt(identity),
    async begin(epoch) {
      const transaction = await inner.begin(epoch);
      return {
        ...transaction,
        async commit() {
          if (lost) {
            lost = false;
            await transaction.commit();
            throw createOwnerError("commit_unknown", "response lost");
          }
          await transaction.commit();
        },
      };
    },
  };
  const hold = deferred();
  const { owner } = await started(commands, { store, holdReady: hold.promise });
  const kept = owner.submit(request("put", "logical", "kept", {}));
  const dropped = owner.submit(request("put", "logical", "dropped", {}));
  hold.resolve();

  assert.deepStrictEqual(await kept, { status: "ownership_lost" });
  assert.deepStrictEqual(await dropped, { status: "ownership_lost" });
  assert.deepStrictEqual(callbacks, []);
  const reason = await owner.stopped;
  assert.ok(reason instanceof Error && "code" in reason);
  assert.equal(reason.code, "commit_unknown");
  const receipt = await owner.lookupReceipt({
    domain: "logical",
    key: "kept",
  });
  assert.ok(receipt);

  const successor = createOwner({ store: inner, commands });
  await successor.ready;
  assert.deepStrictEqual(
    await successor.submit(request("put", "logical", "kept", {})),
    { status: "duplicate", result: { ok: true } },
  );
  assert.deepStrictEqual(
    await successor.submit(request("put", "logical", "dropped", {})),
    { status: "duplicate", result: { ok: true } },
  );
  assert.deepStrictEqual(runs, ["kept", "dropped"]);
  await successor.stop();
});

test("a lost commit that aborted reruns each command once", async () => {
  const inner = createMemoryOwnerStore();
  let lost = true;
  const runs: string[] = [];
  const commands: Record<string, CommandHandler<MemoryTables>> = {
    put: (tx, _input, context) => {
      runs.push(context.identity.key);
      tx.put("rows", context.identity.key, { n: runs.length });
      return { n: runs.length };
    },
  };
  const store: OwnerStore<MemoryTables> = {
    acquire: () => inner.acquire(),
    readReceipt: (identity) => inner.readReceipt(identity),
    async begin(epoch) {
      const transaction = await inner.begin(epoch);
      return {
        ...transaction,
        async commit() {
          if (lost) {
            lost = false;
            await transaction.rollback();
            throw createOwnerError("commit_unknown", "response lost");
          }
          await transaction.commit();
        },
      };
    },
  };
  const { owner } = await started(commands, { store });
  const outcome = await owner.submit(request("put", "logical", "only", {}));
  assert.deepStrictEqual(outcome, { status: "ownership_lost" });

  const successor = createOwner({ store: inner, commands });
  await successor.ready;
  assert.deepStrictEqual(
    await successor.submit(request("put", "logical", "only", {})),
    { status: "committed", result: { n: 2 } },
  );
  assert.deepStrictEqual(runs, ["only", "only"]);
  assert.deepStrictEqual(await inner.read("rows", "only"), { n: 2 });
  await successor.stop();
});

test("a definitive rollback retries each command on its own", async () => {
  const inner = createMemoryOwnerStore();
  let fail = true;
  const runs: string[] = [];
  const commands: Record<string, CommandHandler<MemoryTables>> = {
    put: (tx, _input, context) => {
      runs.push(context.identity.key);
      tx.put("rows", context.identity.key, { ok: true });
      return { ok: true };
    },
  };
  const store: OwnerStore<MemoryTables> = {
    acquire: () => inner.acquire(),
    readReceipt: (identity) => inner.readReceipt(identity),
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
  const hold = deferred();
  const { owner } = await started(commands, { store, holdReady: hold.promise });
  const first = owner.submit(request("put", "logical", "a", {}));
  const second = owner.submit(request("put", "logical", "b", {}));
  hold.resolve();

  assert.deepStrictEqual(await first, {
    status: "committed",
    result: { ok: true },
  });
  assert.deepStrictEqual(await second, {
    status: "committed",
    result: { ok: true },
  });
  assert.deepStrictEqual(runs, ["a", "b", "a", "b"]);
  await owner.stop();
});

test("post-commit callbacks run only after the commit is durable", async () => {
  const store = createMemoryOwnerStore();
  const seen: unknown[] = [];
  const hold = deferred();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { owner } = await started(
    {
      put: async (tx, _input, context) => {
        tx.put("rows", "a", { n: 1 });
        context.afterCommit(() => {
          seen.push("callback");
        });
        hold.resolve();
        await gate;
        return { n: 1 };
      },
    },
    { store },
  );

  const pending = owner.submit(request("put", "logical", "a", {}));
  await hold.promise;
  let visible = false;
  const read = store.read("rows", "a").then((value) => {
    visible = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(visible, false);
  assert.deepStrictEqual(seen, []);
  release();

  assert.deepStrictEqual(await pending, {
    status: "committed",
    result: { n: 1 },
  });
  assert.deepStrictEqual(await read, { n: 1 });
  assert.deepStrictEqual(seen, ["callback"]);
  await owner.stop();
});

test("a failed command does not run its post-commit callback", async () => {
  const seen: string[] = [];
  const { owner } = await started({
    put: (_tx, input, context) => {
      context.afterCommit(() => {
        seen.push("callback");
      });
      if ((input as { fail?: boolean }).fail) context.conflict("no");
      return { ok: true };
    },
  });

  assert.deepStrictEqual(
    await owner.submit(request("put", "logical", "bad", { fail: true })),
    { status: "conflict", reason: "no" },
  );
  assert.deepStrictEqual(seen, []);
  await owner.stop();
});

test("admission admits 32 and recovers a receipt at capacity", async () => {
  const { owner } = await started({
    admit: (tx, _input, context) => {
      if (tx.list("ops").length >= 32) {
        context.refuse("operation_replay_capacity_exceeded");
      }
      tx.put("ops", context.identity.key, { ok: true });
      return { ok: true };
    },
  });

  const outcomes = await Promise.all(
    Array.from({ length: 33 }, (_, index) =>
      owner.submit(request("admit", "logical", `op-${index}`, {})),
    ),
  );
  const admitted = outcomes.filter((outcome) => outcome.status === "committed");
  const refused = outcomes.filter((outcome) => outcome.status === "refused");
  assert.equal(admitted.length, 32);
  assert.deepStrictEqual(refused, [
    {
      status: "refused",
      reason: "operation_replay_capacity_exceeded",
    },
  ]);

  assert.deepStrictEqual(
    await owner.submit(request("admit", "logical", "op-0", {})),
    { status: "duplicate", result: { ok: true } },
  );
  await owner.stop();
});

test("a full queue refuses and a stopped owner reports ownership lost", async () => {
  const entered = deferred();
  const release = deferred();
  const { owner } = await started(
    {
      hold: async () => {
        entered.resolve();
        await release.promise;
        return null;
      },
    },
    { maxQueuedCommands: 1 },
  );

  const running = owner.submit(request("hold", "logical", "running"));
  await entered.promise;
  const queued = owner.submit(request("hold", "logical", "queued"));
  const refused = await owner.submit(request("hold", "logical", "extra"));
  assert.deepStrictEqual(refused, {
    status: "refused",
    reason: "owner_overloaded",
  });

  release.resolve();
  assert.deepStrictEqual(await running, { status: "committed", result: null });
  assert.deepStrictEqual(await queued, { status: "committed", result: null });
  await owner.stop();
  assert.deepStrictEqual(
    await owner.submit(request("hold", "logical", "after")),
    { status: "ownership_lost" },
  );
});

test("a command runs the input that was submitted", async () => {
  const seen: unknown[] = [];
  const hold = deferred();
  const { owner } = await started(
    {
      put: (_tx, input) => {
        seen.push(structuredClone(input));
        return input;
      },
    },
    { holdReady: hold.promise },
  );
  const input = { value: 1 };
  const pending = owner.submit(request("put", "logical", "k", input));
  input.value = 2;
  hold.resolve();
  await owner.ready;

  assert.deepStrictEqual(await pending, {
    status: "committed",
    result: { value: 1 },
  });
  assert.deepStrictEqual(seen, [{ value: 1 }]);
  assert.deepStrictEqual(
    await owner.submit(request("put", "logical", "k", { value: 1 })),
    { status: "duplicate", result: { value: 1 } },
  );
  await owner.stop();
});

test("changing a returned receipt does not change the recorded one", async () => {
  const { owner } = await started({
    put: (_tx, input) => input,
  });
  const committed = await owner.submit(
    request("put", "logical", "k", { value: 1 }),
  );
  const receipt = await owner.lookupReceipt({ domain: "logical", key: "k" });
  (receipt?.result as { value: number }).value = 9;
  (committed as unknown as { result: { value: number } }).result.value = 8;

  const duplicate = await owner.submit(
    request("put", "logical", "k", { value: 1 }),
  );
  assert.deepStrictEqual(duplicate, {
    status: "duplicate",
    result: { value: 1 },
  });
  (duplicate as unknown as { result: { value: number } }).result.value = 7;
  assert.deepStrictEqual(
    (await owner.lookupReceipt({ domain: "logical", key: "k" }))?.result,
    { value: 1 },
  );
  await owner.stop();
});

test("commands in one group keep their own results", async () => {
  const box = { value: 0 };
  const hold = deferred();
  const { owner } = await started(
    {
      put: (_tx, input) => {
        box.value = (input as { value: number }).value;
        return box;
      },
    },
    { holdReady: hold.promise },
  );
  const first = owner.submit(request("put", "logical", "a", { value: 1 }));
  const second = owner.submit(request("put", "logical", "b", { value: 2 }));
  hold.resolve();
  await owner.ready;

  assert.deepStrictEqual(await first, {
    status: "committed",
    result: { value: 1 },
  });
  assert.deepStrictEqual(await second, {
    status: "committed",
    result: { value: 2 },
  });
  assert.deepStrictEqual(
    await owner.submit(request("put", "logical", "a", { value: 1 })),
    { status: "duplicate", result: { value: 1 } },
  );
  await owner.stop();
});

test("a stale owner fails once a successor acquires the epoch", async () => {
  const store = createMemoryOwnerStore();
  const commands: OwnerOptions<MemoryTables>["commands"] = {
    put: (tx, input, context) => {
      tx.put("rows", context.identity.key, input);
      return input;
    },
  };
  const first = createOwner({ store, commands });
  await first.ready;
  const second = createOwner({ store, commands });
  await second.ready;

  assert.deepStrictEqual(
    await first.submit(request("put", "logical", "a", { n: 1 })),
    { status: "ownership_lost" },
  );
  assert.deepStrictEqual(
    await second.submit(request("put", "logical", "a", { n: 1 })),
    { status: "committed", result: { n: 1 } },
  );
  await second.stop();
});

test("an unknown command is invalid", async () => {
  const { owner } = await started({});
  assert.deepStrictEqual(
    await owner.submit(request("missing", "logical", "a")),
    {
      status: "invalid",
      reason: "unknown command type missing",
    },
  );
  await owner.stop();
});
