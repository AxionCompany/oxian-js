import type { Pool } from "pg";

/** A query in the owner's open transaction. */
export type PostgresQuery = Readonly<{
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}>;

export type PostgresOwnerStoreOptions = Readonly<{
  pool: Pool;
  /** Opaque owner id. The epoch and receipts are keyed by it. */
  ownerId: string;
  /** Identifies this process in `owner_epochs.holder`. */
  holder: string;
  /** Schema that holds `owner_epochs` and `receipts`. Defaults to `public`. */
  schema?: string;
  /**
   * False when the shard map does not assign this owner here. Acquire then
   * fails without changing the epoch.
   */
  assigned?: () => boolean;
}>;
