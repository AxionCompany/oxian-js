import { globSync, readFileSync, writeFileSync } from "node:fs";

const argument = process.argv[2];
const version =
  argument?.endsWith(".json") === true
    ? JSON.parse(readFileSync(argument, "utf8")).version
    : argument;
if (
  typeof version !== "string" ||
  !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    version,
  )
) {
  throw new Error("Usage: stamp_deno_version.mjs <semver|package.json>");
}
const deno = JSON.parse(readFileSync("deno.json", "utf8"));
const previousVersion = deno.version;
for (const filename of globSync(["README.md", "docs/**/*.md"])) {
  const source = readFileSync(filename, "utf8");
  let stamped = source.replaceAll(
    `jsr:${deno.name}@${previousVersion}`,
    `jsr:${deno.name}@${version}`,
  );
  if (filename === "docs/api-reference.md") {
    stamped = stamped.replaceAll(
      `version \`${previousVersion}\``,
      `version \`${version}\``,
    );
  }
  if (stamped !== source) writeFileSync(filename, stamped);
}
deno.version = version;
writeFileSync("deno.json", `${JSON.stringify(deno, null, 2)}\n`);
console.log(version);
