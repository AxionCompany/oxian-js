import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "Usage: node scripts/pack-sibling.mjs [--json | --help]";

/** Build the npm artifact without installing, linking, or publishing anything. */
export function packSibling() {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  // Keep stdout machine-readable, even when the existing builder logs progress.
  execFileSync(process.execPath, ["scripts/build_npm.mjs", sha], {
    cwd: root,
    stdio: ["ignore", 2, 2],
  });
  const destination = join(root, "build/siblings");
  mkdirSync(destination, { recursive: true });
  const staging = mkdtempSync(join(destination, ".pack-"));
  try {
    const packages = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", staging],
        { cwd: join(root, "build/npm"), encoding: "utf8" },
      ),
    );
    const packed = packages[0];
    if (
      packages.length !== 1 ||
      packed?.name !== "oxianjs" ||
      typeof packed.filename !== "string" ||
      basename(packed.filename) !== packed.filename ||
      !packed.filename.endsWith(".tgz")
    ) {
      throw new Error("npm pack did not return one Oxian tarball");
    }
    const archive = join(staging, packed.filename);
    // Uncommitted edits can share a Git revision/version. Distinct content must
    // get a distinct path so a consumer never reuses an older local tarball.
    const digest = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    const tarball = join(
      destination,
      `${packed.filename.slice(0, -4)}-${digest}.tgz`,
    );
    renameSync(archive, tarball);
    return { tarball, packed, sha };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      `${usage}\nBuild and pack this checkout; never modify consumers.`,
    );
  } else if (
    args.length !== 0 &&
    !(args.length === 1 && args[0] === "--json")
  ) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    const { tarball, packed, sha } = packSibling();
    console.log(
      args[0] === "--json"
        ? JSON.stringify({
            tarball,
            name: packed.name,
            version: packed.version,
            integrity: packed.integrity,
            revision: sha,
          })
        : tarball,
    );
  }
}
