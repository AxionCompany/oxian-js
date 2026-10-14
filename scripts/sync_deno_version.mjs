import { readFileSync, writeFileSync } from "node:fs";
import { stableVersion } from "./next_version.mjs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = stableVersion(packageJson.version);
const deno = JSON.parse(readFileSync("deno.json", "utf8"));
deno.version = version;
writeFileSync("deno.json", `${JSON.stringify(deno, null, 2)}\n`);
console.log(version);
