import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("JSR prerelease stamping updates install examples without changing release history", () => {
  const directory = mkdtempSync(join(tmpdir(), "oxian-stamp-test-"));
  const script = fileURLToPath(
    new URL("./stamp_deno_version.mjs", import.meta.url),
  );
  const version = "0.22.0-next.abcdef0";
  try {
    mkdirSync(join(directory, "docs"));
    writeFileSync(
      join(directory, "deno.json"),
      JSON.stringify({
        name: "@oxian/oxian-js",
        version: "0.22.0",
      }),
    );
    writeFileSync(
      join(directory, "README.md"),
      'import "jsr:@oxian/oxian-js@0.22.0/worker";\nBase 0.22.0 is not a stable release.',
    );
    writeFileSync(
      join(directory, "docs/api-reference.md"),
      'API version `0.22.0`\nimport "jsr:@oxian/oxian-js@0.22.0";',
    );
    writeFileSync(
      join(directory, "CHANGELOG.md"),
      "## 0.22.0\nPrerelease base.",
    );
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const result = spawnSync("node", [script, version], {
        cwd: directory,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(
      JSON.parse(readFileSync(join(directory, "deno.json"), "utf8")).version,
      version,
    );
    assert.equal(
      readFileSync(join(directory, "README.md"), "utf8"),
      `import "jsr:@oxian/oxian-js@${version}/worker";\nBase 0.22.0 is not a stable release.`,
    );
    assert.equal(
      readFileSync(join(directory, "docs/api-reference.md"), "utf8"),
      `API version \`${version}\`\nimport "jsr:@oxian/oxian-js@${version}";`,
    );
    assert.equal(
      readFileSync(join(directory, "CHANGELOG.md"), "utf8"),
      "## 0.22.0\nPrerelease base.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("privileged prerelease workflow only accepts successful same-repository main pushes", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/prerelease.yml", import.meta.url),
    "utf8",
  );
  const guard = workflow.match(/if: >-\n([\s\S]*?)\n {4}runs-on:/)?.[1];
  assert.ok(guard);
  assert.deepEqual(
    guard.split("&&").map((part) => part.trim()),
    [
      "github.event_name == 'workflow_run'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_repository.full_name == github.repository",
      "github.event.workflow_run.head_branch == 'main'",
      "github.repository == 'AxionCompany/oxian-js'",
    ],
  );
  assert.match(workflow, /ref: \$\{\{ github.event.workflow_run.head_sha \}\}/);
  assert.match(workflow, /npm publish --provenance --access public --tag next/);
});

test("stable releases publish from the trusted workflow only after tag validation and a verified main revision", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/prerelease.yml", import.meta.url),
    "utf8",
  );
  const release = workflow.split("\n  release:\n")[1];
  assert.ok(release, "release job lives in the trusted workflow file");
  const guard = release.match(/if: >-\n([\s\S]*?)\n {4}#/)?.[1];
  assert.ok(guard);
  assert.deepEqual(
    guard.split("&&").map((part) => part.trim()),
    [
      "github.event_name != 'workflow_run'",
      "github.repository == 'AxionCompany/oxian-js'",
    ],
  );
  const step = (text: string) => release.indexOf(text);
  const publish = step("npm publish --provenance --access public\n");
  assert.ok(publish > 0);
  for (
    const before of [
      "validate_publish_release.ts",
      "actions/workflows/verify.yml/runs",
    ]
  ) {
    assert.ok(step(before) > 0 && step(before) < publish, before);
  }
  // One publishing path: npm trusts a single workflow file for this package.
  assert.equal(
    existsSync(new URL("../.github/workflows/publish.yml", import.meta.url)),
    false,
  );
});
