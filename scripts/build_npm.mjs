import { execFileSync } from "node:child_process";
import {
  cpSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { nextVersion, stableVersion } from "./next_version.mjs";

const NPM_NAME = "oxianjs";

const sha = process.argv[2];
const source = JSON.parse(readFileSync("deno.json", "utf8"));
const tooling = JSON.parse(readFileSync("package.json", "utf8"));
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
mkdirSync("build/npm/docs", { recursive: true });
// Ship the same public documentation allowlist as JSR, including guide links.
// Historical internal plans remain outside that allowlist.
for (const path of globSync(
  source.publish.include.filter((path) => path.startsWith("docs/")),
  { exclude: source.publish.exclude },
)) {
  const target = `build/npm/${path}`;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(path, target, { recursive: true });
}
cpSync("CHANGELOG.md", "build/npm/CHANGELOG.md");
writeFileSync(
  "build/npm/README.md",
  `# Oxian for Node\n\nFetch-native applications and streaming work over in-process or WebSocket transports.\n\nRequires Node 24 or newer. This package exports the portable root, http, hypervisor,\nprotocol, providers, transport, work, worker, and adapters/node. The providers\nsubpath contains only portable providers; it does not include local processes.\n\nThe filesystem app factories, config loader, file router, local composition, edge,\nDeno adapter, and CLI remain available only in the Deno/JSR package during the\nNode migration. The retired owner, host, and PostgreSQL-owner APIs are not included;\nsee the [retirement and migration notes](docs/owner-retirement.md).\n\nOptional [worker-to-host calls](docs/worker-host-calls.md) reuse the authenticated\nconnection and require explicit host admission.\n\nSee https://github.com/AxionCompany/oxian-js for documentation.\n`,
);
const entrypoints = {
  ".": "src/mod",
  "./adapters/node": "src/adapters/node/index",
  "./http": "src/http/index",
  "./hypervisor": "src/hypervisor/index",
  "./protocol": "src/protocol/index",
  "./providers": "src/providers/core",
  "./transport": "src/transport/index",
  "./work": "src/work/index",
  "./worker": "src/worker/index",
};
writeFileSync(
  "build/npm/package.json",
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version,
      description: "Fetch-native applications and streaming worker dispatch",
      type: "module",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/AxionCompany/oxian-js.git",
      },
      engines: { node: ">=24" },
      exports: Object.fromEntries(
        Object.entries(entrypoints).map(([subpath, entrypoint]) => [
          subpath,
          {
            types: `./${entrypoint}.d.ts`,
            default: `./${entrypoint}.js`,
          },
        ]),
      ),
      dependencies: { ws: tooling.dependencies.ws },
      files: ["src", "docs", "CHANGELOG.md", "LICENSE", "README.md"],
    },
    null,
    2,
  )}\n`,
);
console.log(`${NPM_NAME}@${version}`);
