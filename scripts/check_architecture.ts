const SOURCE_ROOT = new URL("../src/", import.meta.url);
const CLI_ENTRYPOINT = new URL("../cli.ts", import.meta.url);

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
  "worker-websocket",
  "HypervisorWork",
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
  for (const term of retiredTopologyTerms) {
    if (file.source.includes(term)) {
      errors.push(
        `${file.relativePath}: retired topology term ${term} is not allowed`,
      );
    }
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

function relative(url: URL): string {
  return decodeURIComponent(url.href.slice(SOURCE_ROOT.href.length)).replace(
    /\/$/,
    "",
  );
}
