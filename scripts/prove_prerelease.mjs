import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextVersion } from "./next_version.mjs";

const ENTRYPOINTS = [
  ".",
  "./adapters/node",
  "./http",
  "./hypervisor",
  "./protocol",
  "./providers",
  "./transport",
  "./work",
  "./worker",
];

const PROOF = `
import assert from "node:assert/strict";
import { createHypervisor } from "oxianjs";
import { createWorker } from "oxianjs/worker";
import { createConnectionBudget, serve } from "oxianjs/adapters/node";

for (const subpath of ${JSON.stringify(ENTRYPOINTS)}) {
  await import(subpath === "." ? "oxianjs" : "oxianjs" + subpath.slice(1));
}
for (const subpath of ["host", "owner", "adapters/postgres", "adapters/deno",
  "app", "config", "local", "router", "edge", "cli", "bin"]) {
  await assert.rejects(import("oxianjs/" + subpath), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
}
assert.equal("createLocalProcessProvider" in await import("oxianjs/providers"), false);

const workerCalls = { admit: context => {
  assert.equal(context.parent.workload, "echo");
  assert.equal(context.fence.identity.workerId, context.definition.workerId);
  return ({ input }) => input;
} };
async function reverseEcho({ input, callHost }) {
  const call = await callHost({ workload: "host.echo", body: input });
  await call.started;
  return { body: call.output };
}
async function echo(hypervisor) {
  const bytes = new TextEncoder().encode("installed npm dispatcher and worker");
  const operation = await hypervisor.dispatch({
    workload: "echo",
    body: bytes,
    deadlineAtMs: Date.now() + 5_000,
  });
  assert.deepEqual(
    new Uint8Array(await new Response(operation.output).arrayBuffer()),
    bytes,
  );
  await operation.completed;
}

const transport = {
  type: "in-process",
  config: { topic: "npm-proof-" + crypto.randomUUID() },
};
const local = createHypervisor({ transports: [transport], workerCalls });
const localWorker = createWorker({
  id: "npm-local-worker",
  transport,
  hostCalls: {},
  workloads: { echo: reverseEcho },
});
try {
  await localWorker.ready;
  await echo(local);
} finally {
  await localWorker.stop("npm_proof_complete");
  await localWorker.closed;
  await local.shutdown("npm_proof_complete");
}

// A one-worker, one-session fixture: credentials and admission are application-owned.
const identity = {
  workerId: "npm-websocket-worker",
  attemptId: crypto.randomUUID(),
  epoch: 1,
};
const registration = { kind: "registration", capability: crypto.randomUUID() };
const remote = createHypervisor({
  transports: [{ type: "websocket", config: { path: "/workers" } }],
  workerCalls,
  admit: ({ identity: receivedIdentity, credential }) => {
    assert.deepEqual(receivedIdentity, identity);
    assert.deepEqual(credential, registration);
    return {
      definition: {
        workerId: identity.workerId,
        providerId: "npm-proof",
        workloads: ["echo"],
        capacity: 1,
        providerConfig: {},
        labels: {},
      },
      sessionGeneration: 1,
      authenticatedWith: "registration",
      resume: {
        credential: { kind: "resume", capability: crypto.randomUUID() },
        expiresAtMs: Date.now() + 60_000,
      },
    };
  },
  fallback: () => new Response("npm-listener"),
  config: { shutdownTimeoutMs: 1_000 },
});
const budget = createConnectionBudget(1);
let listener;
let remoteWorker;
try {
  listener = await serve({ hypervisor: remote, budget });
  assert.equal(await (await fetch(listener.url)).text(), "npm-listener");
  const url = new URL("/workers", listener.url);
  url.protocol = "ws:";
  remoteWorker = createWorker({
    id: identity.workerId,
    capacity: 1,
    transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
    activate: () => identity,
    register: () => ({ credential: registration, expiresAtMs: Date.now() + 60_000 }),
    reconnectDelay: false,
    hostCalls: {},
    workloads: { echo: reverseEcho },
  });
  await remoteWorker.ready;
  assert.equal(budget.snapshot().connections, 1);
  await echo(remote);
} finally {
  await remoteWorker?.stop("npm_proof_complete");
  await remoteWorker?.closed;
  await remote.shutdown("npm_proof_complete");
  await listener?.shutdown();
  budget.close();
}
console.log("Installed npm imports and worker-to-host round trips over in-process and Node WebSocket passed");
`;

const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
execFileSync(process.execPath, ["scripts/build_npm.mjs", sha], {
  stdio: "inherit",
});
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--json"], {
    cwd: "build/npm",
    encoding: "utf8",
  }),
);
const filename = packed[0]?.filename;
if (typeof filename !== "string") {
  throw new Error("npm pack returned no tarball");
}
for (const { path } of packed[0].files) {
  assert.doesNotMatch(path, /(?:^|\/)tests?\//);
  assert.doesNotMatch(path, /(?:\.test|_test)\.(?:js|d\.ts)$/);
  assert.ok(!path.endsWith(".ts") || path.endsWith(".d.ts"), path);
}
const directory = mkdtempSync(join(tmpdir(), "oxian-next-"));
try {
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(process.cwd(), "build/npm", filename),
    ],
    { cwd: directory, stdio: "inherit" },
  );
  const packageDirectory = join(directory, "node_modules/oxianjs");
  const installed = JSON.parse(
    readFileSync(join(packageDirectory, "package.json"), "utf8"),
  );
  const source = JSON.parse(readFileSync("deno.json", "utf8"));
  const tooling = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(installed.name, "oxianjs");
  assert.equal(installed.version, nextVersion(source.version, sha));
  assert.deepEqual(Object.keys(installed.exports), ENTRYPOINTS);
  assert.deepEqual(installed.dependencies, { ws: tooling.dependencies.ws });
  assert.ok(existsSync(join(packageDirectory, "docs/owner-retirement.md")));
  for (const path of [
    "docs/worker-host-calls.md",
    "docs/worker-protocol-v1.md",
    "docs/api/work.md",
    "docs/api/worker.md",
    "docs/api/hypervisor.md",
  ]) {
    assert.ok(existsSync(join(packageDirectory, path)), path);
  }
  assert.equal(
    existsSync(join(packageDirectory, "docs/v0.21-implementation-plan.md")),
    false,
  );
  for (const entrypoint of Object.values(installed.exports)) {
    assert.ok(existsSync(join(packageDirectory, entrypoint.default)));
    assert.ok(existsSync(join(packageDirectory, entrypoint.types)));
  }
  for (const path of [
    "owner",
    "host",
    "adapters/postgres",
    "adapters/deno",
    "config",
    "local",
    "cli",
    "edge",
  ]) {
    assert.equal(existsSync(join(packageDirectory, "src", path)), false, path);
  }
  assert.equal(
    existsSync(join(packageDirectory, "src/providers/local_process.js")),
    false,
  );
  // The app core references portable router types, but not the file router.
  for (const path of ["src/router/index.js", "src/app/index.js"]) {
    assert.equal(existsSync(join(packageDirectory, path)), false, path);
  }

  writeFileSync(
    join(directory, "consumer.mts"),
    `${ENTRYPOINTS.map((subpath, index) => {
      const name = subpath === "." ? "oxianjs" : `oxianjs${subpath.slice(1)}`;
      return `import type * as Entry${index} from ${JSON.stringify(name)};`;
    }).join("\n")}\nimport type { Dispatcher, WorkInput } from "oxianjs/work";
import { createHypervisor } from "oxianjs/hypervisor";
import { createWorker } from "oxianjs/worker";
import { createConnectionBudget, serve } from "oxianjs/adapters/node";
const transport = { type: "in-process", config: { topic: "types" } } as const;
const hypervisor = createHypervisor({ transports: [transport], workerCalls: {
  admit: context => { const worker: string = context.fence.identity.workerId; void worker; return ({ input }) => input; },
} });
const dispatcher: Dispatcher = hypervisor;
const input: WorkInput = { workload: "echo", body: new Uint8Array([1]) };
void dispatcher.dispatch(input);
createWorker({ id: "types", transport, hostCalls: {}, workloads: { echo: async ({ input, callHost }) => {
  const call = await callHost({ workload: "host.echo", body: input });
  return call.output;
} } });
void serve({ hypervisor, budget: createConnectionBudget(2) });\n`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2024",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ["consumer.mts"],
    }),
  );
  execFileSync(
    process.execPath,
    [join(process.cwd(), "node_modules/typescript/bin/tsc"), "-p", directory],
    { cwd: directory, stdio: "inherit", timeout: 30_000 },
  );
  execFileSync(process.execPath, ["--input-type=module", "-e", PROOF], {
    cwd: directory,
    stdio: "inherit",
    timeout: 30_000,
  });
  console.log(`installed and verified ${installed.name}@${installed.version}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
