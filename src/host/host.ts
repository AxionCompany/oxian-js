import { createOwnerError } from "../owner/primitives.ts";
import {
  CONNECTION_BUDGET,
  type HostOptions,
  type HostSnapshot,
  type OwnerConnection,
  type OwnerHost,
  type ShardMap,
} from "./types.ts";

/** Copies `owners` (owner id to shard id) into a map for this process's shard. */
export function createShardMap(
  shard: string,
  owners: Readonly<Record<string, string>>,
): ShardMap {
  if (shard === "") throw new TypeError("shard must be non-empty");
  const assigned = new Map<string, string>();
  for (const [ownerId, shardId] of Object.entries(owners)) {
    if (ownerId === "" || shardId === "") {
      throw new TypeError("owner and shard ids must be non-empty");
    }
    assigned.set(ownerId, shardId);
  }
  return Object.freeze({
    shard,
    locate: (ownerId: string) => assigned.get(ownerId),
  });
}

/** One process. It starts only the owners its shard map assigns here. */
export function createOwnerHost(options: HostOptions): OwnerHost {
  const { map } = options;
  const budget = options.maxConnections ?? CONNECTION_BUDGET;
  if (
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    budget > CONNECTION_BUDGET
  ) {
    throw new RangeError(
      `maxConnections must be from 1 to ${CONNECTION_BUDGET}`,
    );
  }
  const running = new Map<string, unknown>();
  let connections = 0;
  let closed = false;

  function owns(ownerId: string): boolean {
    return map.locate(ownerId) === map.shard;
  }

  function open<T>(ownerId: string, start: () => T): T {
    if (closed) throw new Error("host is closed");
    if (ownerId === "") throw new TypeError("owner id must be non-empty");
    if (!owns(ownerId)) {
      throw createOwnerError(
        "ownership_lost",
        "owner is not assigned to this host",
      );
    }
    const existing = running.get(ownerId);
    if (existing !== undefined) return existing as T;
    const started = start();
    running.set(ownerId, started);
    return started;
  }

  function connect(): OwnerConnection {
    if (closed) throw new Error("host is closed");
    if (connections >= budget) throw new Error("connection budget exceeded");
    connections += 1;
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        connections -= 1;
      },
    });
  }

  function snapshot(): HostSnapshot {
    return Object.freeze({
      shard: map.shard,
      owners: Object.freeze([...running.keys()]),
      connections,
      budget,
    });
  }

  return Object.freeze({
    map,
    budget,
    open,
    connect,
    owns,
    snapshot,
    close() {
      closed = true;
    },
  });
}
