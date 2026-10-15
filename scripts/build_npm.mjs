import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { nextVersion, stableVersion } from "./next_version.mjs";

const NPM_NAME = "oxianjs";

const sha = process.argv[2];
const source = JSON.parse(readFileSync("deno.json", "utf8"));
if (typeof source.name !== "string" || typeof source.version !== "string") {
  throw new Error("deno.json must contain a name and version");
}
const version =
  sha === undefined
    ? stableVersion(source.version)
    : nextVersion(source.version, sha);

rmSync("build/npm", { recursive: true, force: true });
mkdirSync("build/npm", { recursive: true });
execFileSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.emit.json"],
  { stdio: "inherit" },
);
cpSync("LICENSE", "build/npm/LICENSE");
writeFileSync(
  "build/npm/package.json",
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version,
      description: "Oxian owners and the in-process host",
      type: "module",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/AxionCompany/oxian-js.git",
      },
      engines: { node: ">=24" },
      exports: {
        "./host": {
          types: "./src/host/index.d.ts",
          default: "./src/host/index.js",
        },
        "./owner": {
          types: "./src/owner/index.d.ts",
          default: "./src/owner/index.js",
        },
      },
      files: ["src", "LICENSE"],
    },
    null,
    2,
  )}\n`,
);
console.log(`${NPM_NAME}@${version}`);
