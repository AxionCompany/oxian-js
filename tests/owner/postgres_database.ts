import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const BIN = "/Applications/Postgres.app/Contents/Versions/latest/bin";

/** A pool for the owner tests. Uses `DATABASE_URL` when set, otherwise a small local cluster. */
export async function openTestDatabase(): Promise<{
  pool: pg.Pool;
  close(): Promise<void>;
}> {
  const url = process.env.DATABASE_URL;
  if (url !== undefined && url !== "") {
    const pool = new pg.Pool({ connectionString: url });
    pool.on("error", () => undefined);
    return {
      pool,
      async close() {
        await pool.end();
      },
    };
  }

  const port = await freePort();
  const data = await mkdtemp(join(tmpdir(), "oxian-owner-pg-"));
  await run(`${BIN}/initdb`, [
    "-D",
    data,
    "--username=oxian",
    "--auth=trust",
    "--no-instructions",
  ]);
  await writeFile(
    join(data, "postgresql.conf"),
    [
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "shared_buffers = 32MB",
      "max_wal_size = 64MB",
      "max_connections = 20",
      "unix_socket_directories = '/tmp'",
    ].join("\n"),
  );
  await writeFile(
    join(data, "pg_hba.conf"),
    "host all all 127.0.0.1/32 trust\n",
  );
  await run(`${BIN}/pg_ctl`, [
    "-D",
    data,
    "-l",
    join(data, "server.log"),
    "start",
  ]);
  const pool = new pg.Pool({
    connectionString: `postgres://oxian@127.0.0.1:${port}/postgres`,
  });
  pool.on("error", () => undefined);
  return {
    pool,
    async close() {
      await pool.end();
      await run(`${BIN}/pg_ctl`, ["-D", data, "-m", "immediate", "stop"]).catch(
        () => undefined,
      );
      await rm(data, { recursive: true, force: true });
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}
