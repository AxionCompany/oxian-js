import { readFileSync, writeFileSync } from "node:fs";

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
deno.version = version;
writeFileSync("deno.json", `${JSON.stringify(deno, null, 2)}\n`);
console.log(version);
