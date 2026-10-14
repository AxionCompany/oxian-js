import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROOF = `
import { createOwnerHost, createShardMap } from "@oxian/oxian-js/host";
import { createMemoryOwnerStore, createOwner } from "@oxian/oxian-js/owner";

const host = createOwnerHost({
  map: createShardMap("local", { "owner-1": "local" }),
});
const owner = host.open("owner-1", () =>
  createOwner({
    store: createMemoryOwnerStore(),
    commands: { put: () => ({ ok: true }) },
  }),
);
await owner.ready;
const outcome = await owner.submit({
  type: "put",
  identity: { domain: "logical", key: "a" },
  input: null,
});
if (outcome.status !== "committed") {
  throw new Error("in-process host did not commit");
}
host.close();
await owner.stop();
`;

const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
execFileSync(process.execPath, ["scripts/build_npm.mjs", sha], {
  stdio: "inherit",
});
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json"], {
    cwd: "build/npm",
    encoding: "utf8",
  }),
);
const filename = packed[0]?.filename;
if (typeof filename !== "string")
  throw new Error("npm pack returned no tarball");
const directory = mkdtempSync(join(tmpdir(), "oxian-next-"));
try {
  execFileSync("npm", ["install", join(process.cwd(), "build/npm", filename)], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync(process.execPath, ["--input-type=module", "-e", PROOF], {
    cwd: directory,
    stdio: "inherit",
  });
  const installed = JSON.parse(
    readFileSync(
      join(directory, "node_modules/@oxian/oxian-js/package.json"),
      "utf8",
    ),
  );
  console.log(`installed ${installed.name}@${installed.version}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
