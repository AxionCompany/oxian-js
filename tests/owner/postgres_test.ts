import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Pool } from "pg";
import { createPostgresOwnerStore } from "../../src/adapters/postgres/store.ts";
import type { PostgresQuery } from "../../src/adapters/postgres/types.ts";
import { createOwner } from "../../src/owner/owner.ts";
import { createOwnerError } from "../../src/owner/primitives.ts";
import type {
  CommandRequest,
  IdentityDomain,
  OwnerStore,
  OwnerStoreTransaction,
} from "../../src/owner/types.ts";
import { openTestDatabase } from "./postgres_database.ts";

let pool: Pool;
let closeDatabase: () => Promise<void>;

before(async () => {
  const database = await openTestDatabase();
  pool = database.pool;
  closeDatabase = database.close;
});

after(async () => {
  await closeDatabase();
});

describe("postgres owner", { concurrency: 1 }, () => {
  test("a stale epoch fails after another holder acquires", async () => {
    const schema = schemaOf();
    const first = await store(schema, "holder-a");
    const owner = createOwner({
      store: first,
      commands: {
        put: () => ({ ok: true }),
      },
    });
    await owner.ready;
    await store(schema, "holder-b").then((next) => next.acquire());

    assert.deepStrictEqual(await owner.submit(command("put", "logical", "a")), {
      status: "ownership_lost",
    });
  });

  test("acquire waits until the open transaction ends", async () => {
    const schema = schemaOf();
    const held = await store(schema, "holder-a");
    const epoch = await held.acquire();
    const transaction = await held.begin(epoch);
    const next = store(schema, "holder-b").then((waiting) => waiting.acquire());
    await waitForEpochLock();

    await transaction.commit();
    assert.equal(await next, epoch + 1);
    await held.begin(epoch).then(
      () => assert.fail("stale epoch began"),
      (error: unknown) => {
        assert.equal(isCode(error, "ownership_lost"), true);
      },
    );
  });

  test("a closed snapshot rejects a later query", async () => {
    const schema = schemaOf();
    const held = await store(schema, "holder-a");
    await held.acquire();
    const snapshot = await held.beginSnapshot();
    await snapshot.close();
    await assert.rejects(snapshot.tx.query("SELECT 1"), /snapshot closed/);
  });

  test("a terminated holder releases the epoch lock", async () => {
    const schema = schemaOf();
    const held = await store(schema, "holder-a");
    const epoch = await held.acquire();
    const transaction = await held.begin(epoch);
    const pid = Number(
      (await transaction.tx.query("SELECT pg_backend_pid() AS pid"))[0]?.pid,
    );
    const next = store(schema, "holder-b").then((waiting) => waiting.acquire());
    await waitForEpochLock();

    await pool.query("SELECT pg_terminate_backend($1)", [pid]);
    assert.equal(await next, epoch + 1);
    await transaction.rollback().catch(() => undefined);
  });

  test("an unassigned host does not move the epoch", async () => {
    const schema = schemaOf();
    const refused = await store(schema, "holder-a", () => false);
    await refused.acquire().then(
      () => assert.fail("unassigned host acquired"),
      (error: unknown) => assert.equal(isCode(error, "ownership_lost"), true),
    );
    const rows = await pool.query(`SELECT epoch FROM ${schema}.owner_epochs`);
    assert.equal(rows.rows.length, 0);
  });

  test("a lost commit that reached the server is decided by receipts", async () => {
    await lostCommit("commit");
  });

  test("a lost commit that aborted reruns each command once", async () => {
    await lostCommit("abort");
  });

  test("a failed begin discards the connection when rollback fails", async () => {
    let discarded: Error | undefined;
    let returnedClean = false;
    const client = {
      on() {},
      off() {},
      query(sql: string) {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return Promise.reject(
            Object.assign(new Error("timeout"), { code: "57014" }),
          );
        }
        return Promise.resolve({ rows: [] });
      },
      release(error?: Error) {
        if (error === undefined) returnedClean = true;
        else discarded = error;
      },
    };
    const fakePool = {
      query(sql: string) {
        if (sql.includes("RETURNING epoch")) {
          return Promise.resolve({ rows: [{ epoch: 1 }] });
        }
        return Promise.resolve({ rows: [] });
      },
      connect() {
        return Promise.resolve(client);
      },
    };
    const abandoned = await createPostgresOwnerStore({
      pool: fakePool as unknown as Pool,
      ownerId: "owner-1",
      holder: "holder-a",
    });
    const epoch = await abandoned.acquire();
    await abandoned.begin(epoch).then(
      () => assert.fail("begin succeeded"),
      (error: unknown) => assert.equal(error instanceof Error, true),
    );
    assert.equal(returnedClean, false);
    assert.equal(discarded instanceof Error, true);
  });

  test("an alarm and the sequence head survive takeover", async () => {
    const schema = schemaOf();
    const fires: number[] = [];
    let now = 1_000;
    const commands = {
      publish: async (
        _tx: PostgresQuery,
        input: CommandRequest["input"],
        context: {
          append(body: CommandRequest["input"]): Promise<number>;
          setAlarm(at: number | undefined): Promise<void>;
        },
      ) => {
        const value = input as { n: number; at?: number };
        const seq = await context.append({ n: value.n });
        if (value.at !== undefined) await context.setAlarm(value.at);
        return { seq };
      },
    };
    const options = {
      commands,
      clock: () => now,
      onAlarm: (at: number) => {
        fires.push(at);
      },
      scheduleAlarm: () => () => undefined,
    };
    const first = createOwner({
      ...options,
      store: await store(schema, "holder-a"),
    });
    await first.ready;
    assert.deepStrictEqual(
      await first.submit({
        type: "publish",
        identity: { domain: "logical", key: "one" },
        input: { n: 1, at: 5_000 },
      }),
      { status: "committed", result: { seq: 1 } },
    );
    await first.stop();
    now = 5_000;

    const successor = createOwner({
      ...options,
      store: await store(schema, "holder-b"),
    });
    await successor.ready;
    await waitFor(() => fires.length > 0);
    assert.deepStrictEqual(fires, [5_000]);
    assert.deepStrictEqual(await successor.heartbeat(), { head: 1 });
    await successor.stop();
  });

  test("replacing an alarm keeps a new revision", async () => {
    const schema = schemaOf();
    const kept = await store(schema, "holder-a");
    const fires: number[] = [];
    let now = 0;
    const timers: { at: number; run: () => void }[] = [];
    const owner = createOwner({
      store: kept,
      clock: () => now,
      onAlarm: (at) => {
        fires.push(at);
      },
      scheduleAlarm(at, run) {
        timers.push({ at, run });
        return () => undefined;
      },
      commands: {
        arm: async (
          _tx: PostgresQuery,
          input: CommandRequest["input"],
          context: {
            setAlarm(at: number | undefined): Promise<void>;
          },
        ) => {
          const value = input as { at?: number; clear?: boolean };
          if (value.clear) await context.setAlarm(undefined);
          if (value.at !== undefined) await context.setAlarm(value.at);
          return input;
        },
      },
    });
    await owner.ready;
    await owner.submit({
      type: "arm",
      identity: { domain: "occurrence", key: "first" },
      input: { at: 1_000 },
    });
    await waitFor(() => timers.length > 0);
    now = 1_000;
    timers[0]?.run();
    assert.deepStrictEqual(fires, [1_000]);
    await owner.submit({
      type: "arm",
      identity: { domain: "occurrence", key: "next" },
      input: { clear: true, at: 2_000 },
    });
    const alarm = await kept.readAlarm();
    assert.equal(alarm?.at, 2_000);
    assert.equal((alarm?.revision ?? 0) > 1, true);
    await owner.stop();
  });
});

async function lostCommit(mode: "commit" | "abort"): Promise<void> {
  const schema = schemaOf();
  const inner = await store(schema, "holder-a");
  await pool.query(
    `CREATE TABLE ${schema}.effects (key text PRIMARY KEY, n int NOT NULL)`,
  );
  const calls: string[] = [];
  const commands = {
    put: async (
      tx: PostgresQuery,
      input: CommandRequest["input"],
      context: { identity: { key: string }; conflict(reason: string): never },
    ) => {
      calls.push(context.identity.key);
      const value = input as { n?: number; fail?: boolean };
      if (value.fail) context.conflict("no");
      await tx.query(`INSERT INTO ${schema}.effects (key, n) VALUES ($1, $2)`, [
        context.identity.key,
        value.n ?? 0,
      ]);
      return input;
    },
  };
  const prepared = createOwner({ store: inner, commands });
  await prepared.ready;
  assert.deepStrictEqual(
    await prepared.submit(command("put", "logical", "dup", { n: 1 })),
    { status: "committed", result: { n: 1 } },
  );
  await prepared.stop();

  const hold = deferred();
  const lost = loseResponse(inner, mode, hold.promise);
  const owner = createOwner({ store: lost, commands });
  const duplicate = owner.submit(command("put", "logical", "dup", { n: 1 }));
  const conflicting = owner.submit(command("put", "logical", "dup", { n: 2 }));
  const success = owner.submit(command("put", "logical", "new", { n: 3 }));
  const failed = owner.submit(command("put", "logical", "bad", { fail: true }));
  hold.resolve();

  for (const outcome of await Promise.all([
    duplicate,
    conflicting,
    success,
    failed,
  ])) {
    assert.deepStrictEqual(outcome, { status: "ownership_lost" });
  }
  assert.equal(isCode(await owner.stopped, "commit_unknown"), true);
  if (mode === "commit") {
    const receipt = await owner.lookupReceipt({
      domain: "logical",
      key: "new",
    });
    assert.deepStrictEqual(receipt?.result, { n: 3 });
  }

  const beforeSuccessor = calls.length;
  const successor = createOwner({ store: inner, commands });
  await successor.ready;
  assert.deepStrictEqual(
    await successor.submit(command("put", "logical", "dup", { n: 1 })),
    { status: "duplicate", result: { n: 1 } },
  );
  assert.deepStrictEqual(
    await successor.submit(command("put", "logical", "dup", { n: 2 })),
    {
      status: "invalid",
      reason: "identity already used by a different request",
    },
  );
  const again = await successor.submit(
    command("put", "logical", "new", { n: 3 }),
  );
  assert.deepStrictEqual(
    again,
    mode === "commit"
      ? { status: "duplicate", result: { n: 3 } }
      : { status: "committed", result: { n: 3 } },
  );
  assert.deepStrictEqual(
    await successor.submit(command("put", "logical", "bad", { fail: true })),
    { status: "conflict", reason: "no" },
  );

  const effects = await pool.query(
    `SELECT key, n FROM ${schema}.effects ORDER BY key`,
  );
  assert.deepStrictEqual(effects.rows, [
    { key: "dup", n: 1 },
    { key: "new", n: 3 },
  ]);
  const successorCalls = calls.slice(beforeSuccessor);
  assert.deepStrictEqual(
    successorCalls.filter((key) => key === "new"),
    mode === "commit" ? [] : ["new"],
  );
  assert.deepStrictEqual(
    successorCalls.filter((key) => key === "bad"),
    ["bad"],
  );
  await successor.stop();
}

function loseResponse(
  inner: OwnerStore<PostgresQuery>,
  mode: "commit" | "abort",
  hold: Promise<void>,
): OwnerStore<PostgresQuery> {
  return Object.freeze({
    async acquire() {
      await hold;
      return await inner.acquire();
    },
    readReceipt: (identity) => inner.readReceipt(identity),
    readHead: () => inner.readHead(),
    readAlarm: () => inner.readAlarm(),
    beginSnapshot: () => inner.beginSnapshot(),
    readEpoch: () => inner.readEpoch(),
    async begin(epoch) {
      const transaction = await inner.begin(epoch);
      const wrapped: OwnerStoreTransaction<PostgresQuery> = {
        ...transaction,
        async commit() {
          if (mode === "commit") await transaction.commit();
          else await transaction.rollback();
          throw createOwnerError("commit_unknown", "response lost");
        },
      };
      return wrapped;
    },
  });
}

async function store(
  schema: string,
  holder: string,
  assigned?: () => boolean,
): Promise<OwnerStore<PostgresQuery>> {
  return await createPostgresOwnerStore({
    pool,
    ownerId: "owner-1",
    holder,
    schema,
    ...(assigned === undefined ? {} : { assigned }),
  });
}

function schemaOf(): string {
  return `t_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function waitForEpochLock(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query LIKE '%owner_epochs%'`,
    );
    if (waiting.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("acquire did not wait on the epoch row");
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function command(
  type: string,
  domain: IdentityDomain,
  key: string,
  input: CommandRequest["input"] = null,
): CommandRequest {
  return { type, identity: { domain, key }, input };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
