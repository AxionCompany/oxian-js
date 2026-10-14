/** How many connections one Cloud Run host may hold. */
export const CONNECTION_BUDGET = 1_000;

/**
 * A fixed assignment of owner ids to shards. One process is one shard.
 * An id maps to one shard, so two processes cannot take the same owner.
 */
export type ShardMap = Readonly<{
  shard: string;
  /** The shard that owns `ownerId`, or undefined when this map does not know it. */
  locate(ownerId: string): string | undefined;
}>;

export type HostOptions = Readonly<{
  map: ShardMap;
  /**
   * Open connections this process accepts. Defaults to `CONNECTION_BUDGET`
   * and cannot be higher.
   */
  maxConnections?: number;
}>;

/** One accepted connection. `release` is safe to call twice. */
export type OwnerConnection = Readonly<{
  release(): void;
}>;

export type HostSnapshot = Readonly<{
  shard: string;
  owners: readonly string[];
  connections: number;
  budget: number;
}>;

/** The owners assigned to this process, and the connections it still has room for. */
export type OwnerHost = Readonly<{
  readonly map: ShardMap;
  readonly budget: number;
  /**
   * Starts `ownerId` when this shard owns it. `start` is not called otherwise,
   * so the epoch does not move. Opening an id twice returns the first instance.
   */
  open<T>(ownerId: string, start: () => T): T;
  /** Takes one connection. Throws when the budget is full. */
  connect(): OwnerConnection;
  /** True when this shard owns `ownerId`. */
  owns(ownerId: string): boolean;
  snapshot(): HostSnapshot;
  /** Rejects later opens and connections. Does not stop owners already started. */
  close(): void;
}>;
