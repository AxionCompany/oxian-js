import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("./pack-sibling.mjs", import.meta.url);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "oxian sibling test "));
  const root = join(directory, "oxian-js");
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(script, join(root, "scripts/pack-sibling.mjs"));
  writeFileSync(join(root, "source.txt"), "sibling");
  writeFileSync(
    join(root, "scripts/build_npm.mjs"),
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
if (readFileSync("source.txt", "utf8") === "broken") throw new Error("fixture build failed");
mkdirSync("build/npm", { recursive: true });
writeFileSync("build/npm/package.json", JSON.stringify({
  name: readFileSync("source.txt", "utf8") === "wrong-package" ? "wrong" : "oxianjs",
  version: "0.22.0-next.abcdef0", type: "module",
  exports: "./index.js", scripts: { prepack: "node -e \\"throw new Error('prepack ran')\\"", postinstall: "node -e \\"throw new Error('postinstall ran')\\"" }
}));
writeFileSync("build/npm/index.js", "export const marker = " + JSON.stringify(readFileSync("source.txt", "utf8")) + ";");
console.log("fixture build progress");
`,
  );
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  return {
    directory,
    root,
    run(args: string[] = [], cwd = directory) {
      return spawnSync(
        process.execPath,
        [join(root, "scripts/pack-sibling.mjs"), ...args],
        { cwd, encoding: "utf8" },
      );
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function npm(args: string[], cwd: string) {
  return execFileSync("npm", args, { cwd, encoding: "utf8" });
}

test("sibling pack help and invalid arguments do not build or change cwd", () => {
  const f = fixture();
  try {
    const help = f.run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /pack-sibling\.mjs/);
    assert.equal(existsSync(join(f.root, "build")), false);
    const invalid = f.run(["--consumer", "../copilotz"]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Usage:/);
    assert.equal(invalid.stdout, "");
    assert.equal(existsSync(join(f.root, "build")), false);
  } finally {
    f.close();
  }
});

test("sibling pack is cwd-independent, skips lifecycle scripts and names dirty builds by content", () => {
  const f = fixture();
  try {
    const consumer = join(f.directory, "consumer");
    mkdirSync(join(consumer, "node_modules/oxianjs"), { recursive: true });
    const untouched = [
      "package.json",
      "package-lock.json",
      "node_modules/oxianjs/keep",
    ];
    for (const path of untouched) writeFileSync(join(consumer, path), path);
    const first = f.run(["--json"], consumer);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.name, "oxianjs");
    assert.equal(result.version, "0.22.0-next.abcdef0");
    assert.match(result.revision, /^[0-9a-f]{40}$/);
    assert.match(result.integrity, /^sha512-/);
    assert.ok(result.tarball.startsWith(join(f.root, "build/siblings/")));
    assert.ok(existsSync(result.tarball));
    const second = f.run([], consumer);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout.trim(), result.tarball);
    writeFileSync(join(f.root, "source.txt"), "changed unpublished source");
    const changed = f.run([], consumer);
    assert.equal(changed.status, 0, changed.stderr);
    assert.notEqual(changed.stdout.trim(), result.tarball);
    assert.ok(existsSync(result.tarball), "older artifacts remain usable");
    for (const path of untouched) {
      assert.equal(readFileSync(join(consumer, path), "utf8"), path);
    }
    assert.equal(
      readdirSync(join(f.root, "build/siblings")).some((path) =>
        path.startsWith(".pack-"),
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test("failed sibling build does not print a usable artifact", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "source.txt"), "broken");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fixture build failed/);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(join(f.root, "build/siblings")), false);
  } finally {
    f.close();
  }
});

test("unexpected packed package is rejected and staging files are cleaned up", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "source.txt"), "wrong-package");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not return one Oxian tarball/);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(join(f.root, "build/siblings")), []);
  } finally {
    f.close();
  }
});

test("opt-in tarball override leaves pins and lock unchanged and npm ci restores them", () => {
  const f = fixture();
  try {
    const result = f.run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { tarball } = JSON.parse(result.stdout);
    const baseline = join(f.directory, "baseline");
    mkdirSync(baseline);
    writeFileSync(
      join(baseline, "package.json"),
      JSON.stringify({
        name: "oxianjs",
        version: "0.21.3",
        type: "module",
        exports: "./index.js",
      }),
    );
    writeFileSync(
      join(baseline, "index.js"),
      'export const marker = "baseline";',
    );
    const packed = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json"], baseline),
    );
    const consumer = join(f.directory, "consumer");
    mkdirSync(consumer, { recursive: true });
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "consumer",
        version: "1.0.0",
        private: true,
        type: "module",
        dependencies: { oxianjs: `file:${join(baseline, packed[0].filename)}` },
      }),
    );
    const safe = ["--ignore-scripts", "--no-audit", "--no-fund"];
    npm(["install", ...safe], consumer);
    const paths = [
      join(consumer, "package.json"),
      join(consumer, "package-lock.json"),
    ];
    const before = paths.map((path) => readFileSync(path, "utf8"));
    npm(
      ["install", "--no-save", "--package-lock=false", ...safe, tarball],
      consumer,
    );
    const marker = () =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'console.log((await import("oxianjs")).marker)',
        ],
        { cwd: consumer, encoding: "utf8" },
      ).trim();
    assert.equal(marker(), "sibling");
    assert.deepEqual(
      paths.map((path) => readFileSync(path, "utf8")),
      before,
    );
    npm(["ci", ...safe], consumer);
    assert.equal(marker(), "baseline");
    assert.deepEqual(
      paths.map((path) => readFileSync(path, "utf8")),
      before,
    );
  } finally {
    f.close();
  }
});
