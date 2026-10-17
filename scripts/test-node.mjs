import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

// Tests of the Deno-bound layers (config loader, local runtime,
// CLI, edge, local process provider, Deno publishing).
// They run only in the Deno CI until each layer moves to Node (F1 §8).
const DENO_ONLY = new Set([
  "tests/app/application_test.ts",
  "tests/app/factory_test.ts",
  "tests/cli/commands_test.ts",
  "tests/cli/local_runtime_test.ts",
  "tests/cli/manifest_worker_runtime_test.ts",
  "tests/cli/parser_test.ts",
  "tests/cli/worker_manifest_test.ts",
  "tests/config/config_test.ts",
  "tests/config/loader_test.ts",
  "tests/docs/public_docs_test.ts",
  "tests/edge/cors_test.ts",
  "tests/edge/dev_proxy_test.ts",
  "tests/edge/static_test.ts",
  "tests/exports/public_exports_test.ts",
  "tests/http/wss_tls_integration_test.ts",
  "tests/local/edge_test.ts",
  "tests/providers/local_process_test.ts",
  "tests/release/publish_contract_test.ts",
]);

const files = globSync([
  "tests/**/*_test.ts",
  "src/**/*.test.ts",
  "scripts/*.test.ts",
])
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => !DENO_ONLY.has(file))
  .sort();

const result = spawnSync(
  process.execPath,
  ["--test", "--test-timeout=60000", ...process.argv.slice(2), ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
