import { fromFileUrl } from "@std/path";

type PackageConfig = Readonly<{
  name: string;
  version: string;
  exports: Readonly<Record<string, string>>;
}>;

type DenoDocOutput = Readonly<{
  nodes: Readonly<
    Record<
      string,
      Readonly<{
        symbols: readonly Readonly<{ name: string }>[];
      }>
    >
  >;
}>;

const packageRoot = new URL("../", import.meta.url);
const packageRootPath = fromFileUrl(packageRoot);
const packageConfig = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", packageRoot)),
) as PackageConfig;
const apiLanding = await Deno.readTextFile(
  new URL("docs/api-reference.md", packageRoot),
);

async function documentedSymbols(source: string): Promise<readonly string[]> {
  const output = await new Deno.Command("deno", {
    args: ["doc", "--json", source],
    cwd: packageRootPath,
    stdout: "piped",
    stderr: "piped",
  }).output();

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `deno doc failed for ${source}${
        stderr.length === 0 ? "" : `: ${stderr}`
      }`,
    );
  }

  const document = JSON.parse(
    new TextDecoder().decode(output.stdout),
  ) as DenoDocOutput;
  return [
    ...new Set(
      Object.values(document.nodes).flatMap((node) =>
        node.symbols.map((symbol) => symbol.name)
      ),
    ),
  ].sort();
}

const librarySubpaths = Object.entries(packageConfig.exports)
  .filter(([subpath]) => subpath !== "." && subpath !== "./bin")
  .sort(([left], [right]) => left.localeCompare(right));
const apiPages: string[] = [];
let exportedSymbolCount = 0;

for (const [subpath, source] of librarySubpaths) {
  const moduleName = subpath.slice(2);
  const pagePath = `docs/api/${moduleName}.md`;
  const page = await Deno.readTextFile(new URL(pagePath, packageRoot));
  apiPages.push(page);

  const landingLink = `api/${moduleName}.md`;
  if (!apiLanding.includes(landingLink)) {
    throw new Error(
      `docs/api-reference.md must link ${subpath} to ${landingLink}`,
    );
  }

  const packageSpecifier =
    `${packageConfig.name}@${packageConfig.version}/${moduleName}`;
  if (!page.includes(packageSpecifier)) {
    throw new Error(
      `${pagePath} must show the exact published specifier ${packageSpecifier}`,
    );
  }

  const symbols = await documentedSymbols(source);
  const missing = symbols.filter((symbol) => !page.includes(`\`${symbol}\``));
  if (missing.length > 0) {
    throw new Error(
      `${pagePath} does not reference exported symbol${
        missing.length === 1 ? "" : "s"
      }: ${missing.join(", ")}`,
    );
  }
  exportedSymbolCount += symbols.length;
}

const rootSource = packageConfig.exports["."];
if (rootSource === undefined) {
  throw new Error("deno.json must publish the package root");
}
const rootSymbols = await documentedSymbols(rootSource);
const combinedApiPages = apiPages.join("\n");
const undocumentedRootSymbols = rootSymbols.filter((symbol) =>
  !combinedApiPages.includes(`\`${symbol}\``)
);
if (undocumentedRootSymbols.length > 0) {
  throw new Error(
    `the aggregate package root contains undocumented symbols: ${
      undocumentedRootSymbols.join(", ")
    }`,
  );
}

console.log(
  `API reference covers ${exportedSymbolCount} subpath exports and ${rootSymbols.length} aggregate exports`,
);
