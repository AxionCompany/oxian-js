import type { Pool, PoolClient } from "pg";
import type { JsonValue } from "../../protocol/types.ts";
import type {
  CommandIdentity,
  OwnerAlarm,
  OwnerReadTransaction,
  OwnerStore,
  OwnerStoreTransaction,
  Receipt,
} from "../../owner/types.ts";
import { createOwnerError } from "../../owner/primitives.ts";
import type { PostgresOwnerStoreOptions, PostgresQuery } from "./types.ts";

const SAVEPOINT = "oxian_cmd";

/**
 * Postgres store for one owner. The epoch row is the fence: a takeover's
 * increment waits until the open transaction ends, then receipts decide.
 */
export async function createPostgresOwnerStore(
  options: PostgresOwnerStoreOptions,
): Promise<OwnerStore<PostgresQuery>> {
  const { pool, ownerId, holder } = options;
  if (ownerId === "" || holder === "") {
    throw new TypeError("ownerId and holder must be non-empty");
  }
  const schema = ident(options.schema ?? "public");
  const epochs = `${schema}.owner_epochs`;
  const receipts = `${schema}.receipts`;
  const changes = `${schema}.owner_changes`;
  const alarms = `${schema}.owner_alarms`;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${epochs} (
      owner text PRIMARY KEY,
      epoch bigint NOT NULL,
      holder text NOT NULL
    )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${receipts} (
      owner text NOT NULL,
      domain text NOT NULL,
      key text NOT NULL,
      fingerprint text NOT NULL,
      result jsonb NOT NULL,
      PRIMARY KEY (owner, domain, key)
    )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${changes} (
      owner text NOT NULL,
      seq bigint NOT NULL,
      body jsonb NOT NULL,
      PRIMARY KEY (owner, seq)
    )`,
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${alarms} (
      owner text PRIMARY KEY,
      at bigint,
      revision bigint NOT NULL
    )`,
  );

  const assigned = options.assigned ?? (() => true);

  async function readReceipt(
    identity: CommandIdentity,
    query: Pool | PoolClient = pool,
  ): Promise<Receipt | undefined> {
    const result = await query.query(
      `SELECT domain, key, fingerprint, result
       FROM ${receipts}
       WHERE owner = $1 AND domain = $2 AND key = $3`,
      [ownerId, identity.domain, identity.key],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return Object.freeze({
      identity: Object.freeze({
        domain: row.domain as Receipt["identity"]["domain"],
        key: String(row.key),
      }),
      fingerprint: String(row.fingerprint),
      result: row.result as Receipt["result"],
    });
  }

  return Object.freeze({
    async acquire() {
      if (!assigned()) {
        throw createOwnerError(
          "ownership_lost",
          "owner is not assigned to this host",
        );
      }
      const result = await pool.query(
        `INSERT INTO ${epochs} (owner, epoch, holder) VALUES ($1, 1, $2)
         ON CONFLICT (owner) DO UPDATE
           SET epoch = ${epochs}.epoch + 1, holder = $2
         RETURNING epoch`,
        [ownerId, holder],
      );
      return epochOf(result.rows[0]?.epoch);
    },

    async begin(epoch: number): Promise<OwnerStoreTransaction<PostgresQuery>> {
      const client = await pool.connect();
      const onClientError = () => undefined;
      client.on("error", onClientError);
      let open = true;
      const release = (error?: Error): void => {
        client.off("error", onClientError);
        if (error === undefined) client.release();
        else client.release(error);
      };
      const end = async (sql: "COMMIT" | "ROLLBACK"): Promise<void> => {
        if (!open) return;
        open = false;
        try {
          await client.query(sql);
          release();
        } catch (error) {
          release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      };
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        const fenced = await client.query(
          `UPDATE ${epochs} SET holder = holder
           WHERE owner = $1 AND epoch = $2
           RETURNING epoch`,
          [ownerId, epoch],
        );
        if (fenced.rows.length === 0) {
          await end("ROLLBACK");
          throw createOwnerError(
            "ownership_lost",
            `epoch ${epoch} is no longer current`,
          );
        }
      } catch (error) {
        if (open) {
          open = false;
          try {
            await client.query("ROLLBACK");
            release();
          } catch (rollbackError) {
            // A failed rollback can leave the transaction open. Returning that
            // connection would let a later acquire reuse the old epoch.
            release(
              rollbackError instanceof Error
                ? rollbackError
                : new Error(String(rollbackError)),
            );
          }
        }
        throw error;
      }

      const tx: PostgresQuery = Object.freeze({
        async query(sql: string, params: readonly unknown[] = []) {
          const result = await client.query(sql, [...params]);
          return result.rows;
        },
      });

      return Object.freeze({
        tx,
        async savepoint() {
          await client.query(`SAVEPOINT ${SAVEPOINT}`);
        },
        async release() {
          await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        },
        async rollbackToSavepoint() {
          await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
          await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        },
        readReceipt: (identity: CommandIdentity) =>
          readReceipt(identity, client),
        async append(body: JsonValue) {
          const inserted = await client.query(
            `INSERT INTO ${changes} (owner, seq, body)
             SELECT $1, COALESCE(MAX(seq), 0) + 1, $2::jsonb
             FROM ${changes}
             WHERE owner = $1
             RETURNING seq`,
            [ownerId, JSON.stringify(body)],
          );
          return integerOf(inserted.rows[0]?.seq, "sequence");
        },
        async head() {
          const result = await client.query(
            `SELECT COALESCE(MAX(seq), 0) AS head FROM ${changes} WHERE owner = $1`,
            [ownerId],
          );
          return integerOf(result.rows[0]?.head, "sequence head");
        },
        async setAlarm(at: number | undefined) {
          await client.query(
            `INSERT INTO ${alarms} (owner, at, revision) VALUES ($1, $2, 1)
             ON CONFLICT (owner) DO UPDATE
               SET at = $2, revision = ${alarms}.revision + 1`,
            [ownerId, at ?? null],
          );
        },
        async writeReceipt(receipt: Receipt) {
          await client.query(
            `INSERT INTO ${receipts}
               (owner, domain, key, fingerprint, result)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
              ownerId,
              receipt.identity.domain,
              receipt.identity.key,
              receipt.fingerprint,
              JSON.stringify(receipt.result),
            ],
          );
        },
        async commit() {
          try {
            await end("COMMIT");
          } catch (error) {
            if (isUnknownCommit(error)) {
              throw createOwnerError(
                "commit_unknown",
                "commit response lost",
                error,
              );
            }
            throw error;
          }
        },
        rollback: () => end("ROLLBACK"),
      });
    },

    async readEpoch() {
      const result = await pool.query(
        `SELECT epoch FROM ${epochs} WHERE owner = $1`,
        [ownerId],
      );
      const row = result.rows[0];
      if (row === undefined) return 0;
      return epochOf(row.epoch);
    },
    async beginSnapshot(): Promise<OwnerReadTransaction<PostgresQuery>> {
      const client = await pool.connect();
      const onClientError = () => undefined;
      client.on("error", onClientError);
      let open = true;
      const release = (error?: Error): void => {
        client.off("error", onClientError);
        if (error === undefined) client.release();
        else client.release(error);
      };
      try {
        await client.query("BEGIN");
        await client.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
      } catch (error) {
        open = false;
        await client.query("ROLLBACK").catch(() => undefined);
        release(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return Object.freeze({
        tx: Object.freeze({
          async query(sql: string, params: readonly unknown[] = []) {
            if (!open) throw new Error("snapshot closed");
            const result = await client.query(sql, [...params]);
            return result.rows;
          },
        }),
        async close() {
          if (!open) return;
          open = false;
          try {
            await client.query("COMMIT");
            release();
          } catch (error) {
            release(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
    },
    readReceipt: (identity: CommandIdentity) => readReceipt(identity),
    async readHead() {
      const result = await pool.query(
        `SELECT COALESCE(MAX(seq), 0) AS head FROM ${changes} WHERE owner = $1`,
        [ownerId],
      );
      return integerOf(result.rows[0]?.head, "sequence head");
    },
    async readAlarm(): Promise<OwnerAlarm | undefined> {
      const result = await pool.query(
        `SELECT at, revision FROM ${alarms} WHERE owner = $1 AND at IS NOT NULL`,
        [ownerId],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        at: integerOf(row.at, "alarm time"),
        revision: integerOf(row.revision, "alarm revision"),
      };
    },
  });
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new TypeError(`unsafe SQL identifier ${name}`);
  }
  return name;
}

function epochOf(value: unknown): number {
  const epoch = integerOf(value, "owner epoch");
  if (epoch < 1) throw new TypeError("owner epoch is missing");
  return epoch;
}

function integerOf(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} is missing`);
  return parsed;
}

/** A commit whose response never arrived. A SQLSTATE from the server is a confirmed abort. */
function isUnknownCommit(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  if (
    code === "08000" ||
    code === "08003" ||
    code === "08006" ||
    code === "08001" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03"
  ) {
    return true;
  }
  return !/^[0-9A-Z]{5}$/.test(code);
}
