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
import { packSibling } from "./pack-sibling.mjs";

const ENTRYPOINTS = [
  ".",
  "./adapters/node",
  "./app",
  "./config",
  "./http",
  "./hypervisor",
  "./protocol",
  "./providers",
  "./router",
  "./transport",
  "./work",
  "./worker",
];

const PROOF = `
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApplication, createHypervisor } from "oxianjs";
import { createFileRouter } from "oxianjs/router";
import { defineConfig, loadConfig } from "oxianjs/config";
import { createConfiguredApplication, loadApplicationFactory } from "oxianjs/app";
import { createWorker } from "oxianjs/worker";
import { createConnectionBudget, serve } from "oxianjs/adapters/node";

for (const subpath of ${JSON.stringify(ENTRYPOINTS)}) {
  await import(subpath === "." ? "oxianjs" : "oxianjs" + subpath.slice(1));
}
for (const subpath of ["host", "owner", "adapters/postgres", "adapters/deno",
  "local", "edge", "cli", "bin"]) {
  await assert.rejects(import("oxianjs/" + subpath), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
}
assert.equal("createLocalProcessProvider" in await import("oxianjs/providers"), false);

// Import the real installed router, discover external route modules and execute
// them through the portable application core; no source-checkout imports.
const routeRoot = await mkdtemp(join(tmpdir(), "oxian npm routes #% é-"));
let application;
try {
  await mkdir(join(routeRoot, "users"));
  await writeFile(join(routeRoot, "users/[id].mts"),
    'export const GET = (_request: Request, context: { params: { id: string } }) => new Response(context.params.id);');
  await writeFile(join(routeRoot, "_middleware.mjs"),
    'export const middleware = async (_request, _context, next) => { const response = await next(); response.headers.set("x-router", "installed"); return response; };');
  const router = await createFileRouter({ root: pathToFileURL(routeRoot) });
  assert.equal(router.routes.length, 1);
  assert.deepEqual(router.match("/users/alice%20smith")?.params, { id: "alice smith" });
  application = await createApplication({ router });
  await rm(routeRoot, { recursive: true, force: true });
  const response = await application.fetch(new Request("https://example.test/users/alice%20smith"));
  assert.equal(await response.text(), "alice smith");
  assert.equal(response.headers.get("x-router"), "installed");
} finally {
  await application?.dispose("npm_router_proof_complete");
  await rm(routeRoot, { recursive: true, force: true });
}

// Load application-authored TypeScript outside node_modules from the installed
// package, including package imports inside the configuration and factory.
const configRoot = await mkdtemp(join(process.cwd(), "oxian npm config #% é-"));
let configured;
try {
  await writeFile(join(configRoot, "package.json"), '{"type":"module"}');
  await mkdir(join(configRoot, "routes"));
  await writeFile(join(configRoot, "routes/index.ts"),
    'export const GET = (_request: Request, context: { state?: { marker: string } }) => new Response(context.state?.marker ?? "default");');
  await writeFile(join(configRoot, "oxian.config.ts"),
    'import { defineConfig, type OxianConfigInput } from "oxianjs/config"; const input: OxianConfigInput = { application: { routesRoot: "./routes", basePath: "/api", factory: "./application.ts" } }; export const config = defineConfig(input);');
  await writeFile(join(configRoot, "application.ts"),
    'import { createApplication, defineApplicationFactory } from "oxianjs/app"; export default defineApplicationFactory((context) => { if (!Object.isFrozen(context)) throw new Error("mutable_context"); return createApplication({ router: context.router, basePath: context.basePath, state: { marker: "installed-factory" } }); });');
  const config = await loadConfig(pathToFileURL(join(configRoot, "oxian.config.ts")));
  assert.equal(config.application.routesRoot, join(configRoot, "routes"));
  assert.equal(config.application.factory, join(configRoot, "application.ts"));
  assert.equal(Object.isFrozen(config), true);
  assert.equal(typeof await loadApplicationFactory(config.application.factory), "function");
  configured = await createConfiguredApplication({ config: config.application, signal: new AbortController().signal });
  assert.equal(configured.application.router, configured.router);
  assert.equal(await (await configured.application.fetch(new Request("https://example.test/api"))).text(), "installed-factory");
  await configured.application.dispose();
  configured = await createConfiguredApplication({
    config: defineConfig({ application: { routesRoot: config.application.routesRoot, basePath: "/default" } }).application,
    signal: new AbortController().signal,
  });
  assert.equal(await (await configured.application.fetch(new Request("https://example.test/default"))).text(), "default");
  for (const load of [loadConfig, loadApplicationFactory]) {
    await assert.rejects(load(join(configRoot, "application.js")), TypeError);
    await assert.rejects(load("https://example.test/application.ts"), TypeError);
  }
} finally {
  await configured?.application.dispose("npm_config_proof_complete");
  await rm(configRoot, { recursive: true, force: true });
}

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
console.log("Installed npm config, application factories, router, imports and worker-to-host round trips over in-process and Node WebSocket passed");
`;

const { tarball, packed, sha } = packSibling();
for (const { path } of packed.files) {
  assert.doesNotMatch(path, /(?:^|\/)tests?\//);
  assert.doesNotMatch(path, /(?:\.test|_test)\.(?:js|d\.ts)$/);
  assert.ok(!path.endsWith(".ts") || path.endsWith(".d.ts"), path);
}
const directory = mkdtempSync(join(tmpdir(), "oxian-next-"));
try {
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
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
    "docs/api/router.md",
    "docs/api/config.md",
    "docs/api/app.md",
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
  for (const path of [
    "app/index",
    "app/factory",
    "app/configured",
    "config/index",
    "config/config",
    "adapters/node/config-path",
  ]) {
    assert.ok(existsSync(join(packageDirectory, "src", `${path}.js`)));
    assert.ok(existsSync(join(packageDirectory, "src", `${path}.d.ts`)));
  }
  assert.ok(
    existsSync(join(packageDirectory, "src/adapters/node/file-router.js")),
  );

  writeFileSync(
    join(directory, "consumer.mts"),
    `${ENTRYPOINTS.map((subpath, index) => {
      const name = subpath === "." ? "oxianjs" : `oxianjs${subpath.slice(1)}`;
      return `import type * as Entry${index} from ${JSON.stringify(name)};`;
    }).join("\n")}\nimport type { Dispatcher, WorkInput } from "oxianjs/work";
import { createFileRouter, type FileRouter } from "oxianjs/router";
const router: Promise<FileRouter<{ name: string }>> = createFileRouter<{ name: string }>({ root: new URL("./routes/", import.meta.url) });
void router;
import { defineConfig, loadConfig, type OxianConfig } from "oxianjs/config";
import { createApplication, createConfiguredApplication, defineApplicationFactory, loadApplicationFactory, type ApplicationFactory, type ConfiguredApplication } from "oxianjs/app";
const config: OxianConfig = defineConfig({ application: { routesRoot: "./routes", factory: "./application.ts" } });
const loaded: Promise<OxianConfig> = loadConfig(new URL("./oxian.config.ts", import.meta.url));
const factory: ApplicationFactory<{ name: string }> = defineApplicationFactory(({ router, basePath }) => createApplication({ router, basePath, state: { name: "typed" } }));
const loadedFactory: Promise<ApplicationFactory<{ name: string }>> = loadApplicationFactory<{ name: string }>("./application.ts");
const configured: Promise<ConfiguredApplication> = createConfiguredApplication({ config: config.application, signal: new AbortController().signal });
void [loaded, factory, loadedFactory, configured];
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
