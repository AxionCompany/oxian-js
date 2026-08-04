const PACKAGE_ROOT = new URL("../", import.meta.url);
const ENTRYPOINTS = [
  new URL("src/mod.ts", PACKAGE_ROOT),
  new URL("src/core.ts", PACKAGE_ROOT),
];
const visited = new Set<string>();
const errors: string[] = [];

await Promise.all(ENTRYPOINTS.map(visit));

if (errors.length > 0) {
  console.error("Oxian portability check failed:\n");
  for (const error of errors.sort()) console.error(`- ${error}`);
  Deno.exit(1);
}

console.log(
  `Oxian portability check passed (${visited.size} modules in the root/core dependency closure).`,
);

async function visit(url: URL): Promise<void> {
  if (visited.has(url.href)) return;
  visited.add(url.href);
  const source = await Deno.readTextFile(url);
  const relative = decodeURIComponent(url.href.slice(PACKAGE_ROOT.href.length));

  for (
    const [label, pattern] of [
      ["Deno API", /\bDeno\./],
      ["Bun API", /\bBun\./],
      ["Node builtin", /["']node:/],
      ["Cloudflare runtime", /["']cloudflare:workers["']/],
      ["runtime import map dependency", /["']@std\//],
    ] as const
  ) {
    if (pattern.test(source)) errors.push(`${relative}: contains ${label}`);
  }

  const dependencies = new Set<string>();
  for (
    const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/g,
    )
  ) {
    dependencies.add(match[1]);
  }
  await Promise.all([...dependencies].map(async (specifier) => {
    if (!specifier.startsWith(".")) return;
    const dependency = new URL(specifier, url);
    if (!dependency.pathname.endsWith(".ts")) return;
    await visit(dependency);
  }));
}
