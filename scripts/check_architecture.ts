const SOURCE_ROOT = new URL("../src/", import.meta.url);
const TEST_ROOT = new URL("../tests/", import.meta.url);
const DOCS_ROOT = new URL("../docs/", import.meta.url);
const CLI_ENTRYPOINT = new URL("../cli.ts", import.meta.url);
const README = new URL("../README.md", import.meta.url);

const errors: string[] = [];
const sourceFiles: Array<{ relativePath: string; source: string }> = [];
const retiredTopologyTerms = Object.freeze([
  "WorkerHost",
  "createWorkerHost",
  "WorkerClient",
  "createWorkerClient",
  "attachInProcessWorker",
  "createDenoHypervisor",
  "DenoHypervisor",
  "createInProcessTransport",
  "connectToHypervisor",
  "persistAcceptance",
  "workerPath",
  "RegistrationAuthority",
  "WorkerRepository",
  "createInMemoryRegistrationAuthority",
  "createInMemoryWorkerRepository",
  "worker-websocket",
]);

await collectSource(SOURCE_ROOT);
sourceFiles.push({
  relativePath: "cli.ts",
  source: await Deno.readTextFile(CLI_ENTRYPOINT),
});

for (const file of sourceFiles) {
  for (
    const match of file.source.matchAll(
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class(?:\s+(\w+))?/gm,
    )
  ) {
    errors.push(
      `${file.relativePath}: class declaration ${
        match[1] ?? "<anonymous>"
      } is not allowed`,
    );
  }
  if (/\bthis\s*\./.test(file.source)) {
    errors.push(`${file.relativePath}: this-managed state is not allowed`);
  }
}

const contractFiles = [...sourceFiles, {
  relativePath: "README.md",
  source: await Deno.readTextFile(README),
}];
await collectContractFiles(TEST_ROOT, "tests", ".ts", contractFiles);
await collectContractFiles(DOCS_ROOT, "docs", ".md", contractFiles);

for (const file of contractFiles) {
  if (
    file.relativePath === "docs/migration-0.20.md" ||
    file.relativePath === "docs/migration-0.21.md" ||
    file.relativePath.startsWith("docs/v0.20-") ||
    file.relativePath.startsWith("docs/v0.21-") ||
    file.relativePath.includes("/fixtures/")
  ) {
    continue;
  }
  for (const term of retiredTopologyTerms) {
    if (file.source.includes(term)) {
      errors.push(
        `${file.relativePath}: retired topology term ${term} is not allowed`,
      );
    }
  }
  if (/type:\s*["']in-process["']\s*,\s*hypervisor\b/.test(file.source)) {
    errors.push(
      `${file.relativePath}: direct Hypervisor possession is not an in-process transport declaration`,
    );
  }
}

for (
  const file of sourceFiles.filter((candidate) =>
    candidate.relativePath.startsWith("transport/")
  )
) {
  if (
    /from\s+["'][^"']*(?:worker\/session|hypervisor\/internal)[^"']*["']/.test(
      file.source,
    )
  ) {
    errors.push(
      `${file.relativePath}: a physical transport must not import a Worker or Hypervisor lifecycle kernel`,
    );
  }
}

const workerEntrypoint = sourceFiles.find((file) =>
  file.relativePath === "worker/index.ts"
);
if (
  workerEntrypoint?.source.includes('from "./in-process.ts"') ||
  workerEntrypoint?.source.includes('from "./websocket.ts"')
) {
  errors.push(
    "worker/index.ts: transport-specific Worker factories must remain internal",
  );
}

if (errors.length > 0) {
  console.error("Oxian architecture check failed:\n");
  for (const error of errors) console.error(`- ${error}`);
  Deno.exit(1);
}

console.log(
  `Oxian architecture check passed (${sourceFiles.length} functional source modules; classes and this-managed state are forbidden).`,
);

async function collectSource(directory: URL): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) {
      await collectSource(url);
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    sourceFiles.push({
      relativePath: relative(url),
      source: await Deno.readTextFile(url),
    });
  }
}

async function collectContractFiles(
  directory: URL,
  prefix: string,
  extension: string,
  output: Array<{ relativePath: string; source: string }>,
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) {
      await collectContractFiles(
        url,
        `${prefix}/${entry.name}`,
        extension,
        output,
      );
      continue;
    }
    if (!entry.isFile || !entry.name.endsWith(extension)) continue;
    output.push({
      relativePath: `${prefix}/${entry.name}`,
      source: await Deno.readTextFile(url),
    });
  }
}

function relative(url: URL): string {
  return decodeURIComponent(url.href.slice(SOURCE_ROOT.href.length)).replace(
    /\/$/,
    "",
  );
}
