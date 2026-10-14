import type { JsonValue } from "../protocol/types.ts";
import { createOwnerError, identityKey } from "./primitives.ts";
import type {
  CommandIdentity,
  OwnerStore,
  OwnerStoreTransaction,
  Receipt,
} from "./types.ts";

/** Tables of JSON records, as seen by command handlers. */
export type MemoryTables = Readonly<{
  get(table: string, id: string): JsonValue | undefined;
  put(table: string, id: string, value: JsonValue): void;
  delete(table: string, id: string): void;
  list(table: string): readonly (readonly [string, JsonValue])[];
}>;

export type MemoryOwnerStore = OwnerStore<MemoryTables> &
  Readonly<{
    /** Reads committed state, outside any command. */
    read(table: string, id: string): Promise<JsonValue | undefined>;
  }>;

/** One owner's state in process memory: for tests, the browser and the in-process host. */
export function createMemoryOwnerStore(): MemoryOwnerStore {
  const tables = new Map<string, Map<string, JsonValue>>();
  const receipts = new Map<string, Receipt>();
  let epoch = 0;
  let tail: Promise<void> = Promise.resolve();

  /** One transaction at a time; acquiring an epoch waits for the open one. */
  function lock(): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = tail.then(() => release);
    tail = tail.then(() => released);
    return acquired;
  }

  function tableOf(name: string): Map<string, JsonValue> {
    let table = tables.get(name);
    if (table === undefined) {
      table = new Map();
      tables.set(name, table);
    }
    return table;
  }

  async function begin(
    fenced: number,
  ): Promise<OwnerStoreTransaction<MemoryTables>> {
    const release = await lock();
    if (fenced !== epoch) {
      release();
      throw createOwnerError(
        "ownership_lost",
        `epoch ${fenced} is no longer current (current ${epoch})`,
      );
    }
    const undo: (() => void)[] = [];
    let mark: number | undefined;
    let finished = false;

    const open = (): void => {
      if (finished) throw new TypeError("transaction has finished");
    };
    const write = (name: string, id: string, value?: JsonValue): void => {
      open();
      const table = tableOf(name);
      const existed = table.has(id);
      const previous = table.get(id);
      undo.push(() => {
        if (existed) table.set(id, previous!);
        else table.delete(id);
      });
      if (value === undefined) table.delete(id);
      else table.set(id, structuredClone(value));
    };
    const unwind = (to: number): void => {
      while (undo.length > to) undo.pop()!();
    };

    const tx: MemoryTables = Object.freeze({
      get(name: string, id: string) {
        open();
        const value = tables.get(name)?.get(id);
        return value === undefined ? undefined : structuredClone(value);
      },
      put: (name: string, id: string, value: JsonValue) =>
        write(name, id, value),
      delete: (name: string, id: string) => write(name, id),
      list(name: string) {
        open();
        return [...(tables.get(name) ?? [])].map(
          ([id, value]) => [id, structuredClone(value)] as const,
        );
      },
    });

    return Object.freeze({
      tx,
      savepoint() {
        open();
        mark = undo.length;
        return Promise.resolve();
      },
      release() {
        open();
        mark = undefined;
        return Promise.resolve();
      },
      rollbackToSavepoint() {
        open();
        if (mark === undefined) throw new TypeError("no open savepoint");
        unwind(mark);
        mark = undefined;
        return Promise.resolve();
      },
      readReceipt(identity: CommandIdentity) {
        open();
        return Promise.resolve(
          copyReceipt(receipts.get(identityKey(identity))),
        );
      },
      writeReceipt(receipt: Receipt) {
        open();
        const key = identityKey(receipt.identity);
        const previous = receipts.get(key);
        undo.push(() => {
          if (previous === undefined) receipts.delete(key);
          else receipts.set(key, previous);
        });
        receipts.set(key, structuredClone(receipt));
        return Promise.resolve();
      },
      commit() {
        open();
        finished = true;
        release();
        return Promise.resolve();
      },
      rollback() {
        open();
        unwind(0);
        finished = true;
        release();
        return Promise.resolve();
      },
    });
  }

  async function committed<T>(read: () => T): Promise<T> {
    const release = await lock();
    try {
      return read();
    } finally {
      release();
    }
  }

  return Object.freeze({
    async acquire() {
      return await committed(() => ++epoch);
    },
    begin,
    readReceipt: (identity: CommandIdentity) =>
      committed(() => copyReceipt(receipts.get(identityKey(identity)))),
    read: (table: string, id: string) =>
      committed(() => {
        const value = tables.get(table)?.get(id);
        return value === undefined ? undefined : structuredClone(value);
      }),
  });
}

function copyReceipt(receipt: Receipt | undefined): Receipt | undefined {
  return receipt === undefined ? undefined : structuredClone(receipt);
}
