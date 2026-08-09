const PACKAGE_ROOT = new URL("../", import.meta.url);
const SOURCE_ROOT = new URL("src/", PACKAGE_ROOT);
const config = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", PACKAGE_ROOT)),
) as Readonly<{
  exports: Readonly<Record<string, string>>;
  imports?: Readonly<Record<string, string>>;
}>;
const visited = new Set<string>();
const bareSourceImports = new Set<string>();

await Promise.all(
  Object.values(config.exports).map((entry) =>
    visit(new URL(entry, PACKAGE_ROOT), bareSourceImports)
  ),
);

const sourceFiles: string[] = [];
await collectTypeScript(SOURCE_ROOT, sourceFiles);
const unreachable = sourceFiles.filter((file) =>
  !visited.has(new URL(file, SOURCE_ROOT).href)
);

const testAndToolImports = new Set<string>();
for (const directory of ["tests/", "scripts/"]) {
  const files: string[] = [];
  await collectTypeScript(new URL(directory, PACKAGE_ROOT), files);
  for (const file of files) {
    collectBareImports(
      await Deno.readTextFile(new URL(file, new URL(directory, PACKAGE_ROOT))),
      testAndToolImports,
    );
  }
}

const declared = new Set(Object.keys(config.imports ?? {}));
const unexplainedDependencies = [...declared].filter((specifier) =>
  !bareSourceImports.has(specifier) && !testAndToolImports.has(specifier)
);
// Test and tooling sources intentionally contain package-import examples inside
// strings and fixtures. Only production imports are authoritative for this
// declaration check; declared dependency usage still considers every source.
const undeclaredAliases = [...bareSourceImports].filter(
  (specifier) => specifier.startsWith("@") && !declared.has(specifier),
);

const errors = [
  ...unreachable.map((file) => `src/${file}: unreachable from package exports`),
  ...unexplainedDependencies.map((specifier) =>
    `deno.json imports: ${specifier} is unused by source, tests, and tools`
  ),
  ...undeclaredAliases.map((specifier) =>
    `bare alias ${specifier} is used without a deno.json import`
  ),
];
if (errors.length > 0) {
  console.error("Oxian source/dependency graph check failed:\n");
  for (const error of errors.sort()) console.error(`- ${error}`);
  Deno.exit(1);
}

const productionDependencies = [...declared].filter((specifier) =>
  bareSourceImports.has(specifier)
).sort();
const testOnlyDependencies = [...declared].filter((specifier) =>
  !bareSourceImports.has(specifier) && testAndToolImports.has(specifier)
).sort();
console.log(
  `Oxian source graph passed (${sourceFiles.length} source modules reachable; production dependencies: ${
    productionDependencies.join(", ") || "none"
  }; test/tool-only dependencies: ${
    testOnlyDependencies.join(", ") || "none"
  }).`,
);

async function visit(url: URL, bareImports: Set<string>): Promise<void> {
  if (visited.has(url.href)) return;
  visited.add(url.href);
  const source = await Deno.readTextFile(url);
  const dependencies = dependenciesOf(source);
  for (const specifier of dependencies) {
    if (!specifier.startsWith(".")) {
      bareImports.add(specifier);
      continue;
    }
    const dependency = new URL(specifier, url);
    if (dependency.pathname.endsWith(".ts")) {
      await visit(dependency, bareImports);
    }
  }
}

function dependenciesOf(source: string): Set<string> {
  const dependencies = new Set<string>();
  for (
    const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g,
    )
  ) {
    dependencies.add(match[1]);
  }
  return dependencies;
}

function collectBareImports(source: string, output: Set<string>): void {
  for (const specifier of dependenciesOf(source)) {
    if (!specifier.startsWith(".")) output.add(specifier);
  }
}

async function collectTypeScript(
  directory: URL,
  output: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isDirectory) {
      const nested: string[] = [];
      await collectTypeScript(new URL(`${entry.name}/`, directory), nested);
      output.push(...nested.map((file) => `${entry.name}/${file}`));
      continue;
    }
    if (entry.isFile && entry.name.endsWith(".ts")) output.push(entry.name);
  }
}
