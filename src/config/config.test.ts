import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../../tests/support/assert.ts";
import { DEFAULT_OXIAN_CONFIG, defineConfig } from "./config.ts";
import type { OxianConfig } from "./types.ts";

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.deepStrictEqual(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertTypeErrorMessage(run: () => unknown, message: string): void {
  try {
    run();
    throw new Error("expected callback to throw");
  } catch (error) {
    assert.ok(error instanceof TypeError);
    assert.deepStrictEqual(error.message, message);
  }
}

const defineUnknown = defineConfig as (input: unknown) => OxianConfig;

test("v0.20 config exposes immutable, implemented-only defaults", () => {
  const config = defineConfig({});

  assert.deepStrictEqual(config, DEFAULT_OXIAN_CONFIG);
  assert.deepStrictEqual(config.application.routesRoot, "./routes");
  assert.deepStrictEqual(config.application.basePath, "/");
  assert.deepStrictEqual(config.application.factory, undefined);
  assert.deepStrictEqual(config.gateway.listener, {
    hostname: "127.0.0.1",
    port: 8_000,
  });
  assert.deepStrictEqual(config.gateway.workerTransport, "in-process");
  assert.deepStrictEqual(config.gateway.workerCapacity, 32);
  assert.deepStrictEqual(config.gateway.edge, undefined);
  assertDeepFrozen(config);

  assertThrows(() => {
    (config.gateway.listener as { port: number }).port = 9_000;
  }, TypeError);
});

test("v0.20 config permits listener port zero for ephemeral binding", () => {
  const config = defineConfig({
    gateway: { listener: { port: 0 } },
  });

  assert.deepStrictEqual(config.gateway.listener.port, 0);
});

test("v0.20 config normalizes data-only gateway and edge declarations", () => {
  const methods = ["get", "GET", "post"];
  const headers = ["X-Request-ID", "x-request-id"];
  const input = {
    application: {
      routesRoot: "./api",
      basePath: "/api/v1",
      factory: "./application.ts",
    },
    gateway: {
      listener: { hostname: "localhost", port: 9_090 },
      workerTransport: "websocket",
      workerCapacity: 80,
      hypervisor: {
        heartbeatIntervalMs: 2_000,
        leaseTimeoutMs: 8_000,
      },
      edge: {
        cors: {
          origins: ["https://example.com", "https://example.com"],
          methods,
          headers,
          exposeHeaders: ["X-Trace-ID"],
          credentials: true,
          maxAgeSeconds: 300,
        },
        static: {
          root: "./public",
          prefix: "/assets/",
          index: ["index.html", "index.html", "home.html"],
          fallback: "app/index.html",
          cacheControl: "public, max-age=60",
          fallthrough: false,
        },
        devProxy: {
          upstream: "http://127.0.0.1:5173",
          prefix: "/vite/",
          stripPrefix: true,
          forwardHost: true,
        },
      },
    },
  } as const;

  const config = defineConfig(input);

  assert.deepStrictEqual(config.application.routesRoot, "./api");
  assert.deepStrictEqual(config.application.basePath, "/api/v1");
  assert.deepStrictEqual(config.application.factory, "./application.ts");
  assert.deepStrictEqual(config.gateway.listener, {
    hostname: "localhost",
    port: 9_090,
  });
  assert.deepStrictEqual(config.gateway.workerTransport, "websocket");
  assert.deepStrictEqual(config.gateway.workerCapacity, 80);
  assert.deepStrictEqual(config.gateway.hypervisor.heartbeatIntervalMs, 2_000);
  assert.deepStrictEqual(config.gateway.edge?.cors, {
    origins: ["https://example.com"],
    methods: ["GET", "POST"],
    headers: ["x-request-id"],
    exposeHeaders: ["x-trace-id"],
    credentials: true,
    maxAgeSeconds: 300,
  });
  assert.deepStrictEqual(config.gateway.edge?.static, {
    root: "./public",
    prefix: "/assets",
    index: ["index.html", "home.html"],
    fallback: "app/index.html",
    cacheControl: "public, max-age=60",
    fallthrough: false,
  });
  assert.deepStrictEqual(config.gateway.edge?.devProxy, {
    upstream: "http://127.0.0.1:5173/",
    prefix: "/vite",
    stripPrefix: true,
    forwardHost: true,
  });
  assert.notStrictEqual(config.gateway.edge?.cors?.methods, methods);
  assert.notStrictEqual(config.gateway.edge?.cors?.headers, headers);
  assert.deepStrictEqual(methods, ["get", "GET", "post"]);
  assert.deepStrictEqual(headers, ["X-Request-ID", "x-request-id"]);
  assertDeepFrozen(config);
});

test("v0.20 config rejects unknown keys at every owned boundary", () => {
  assertTypeErrorMessage(
    () => defineUnknown({ server: {} }),
    'config contains unknown key "server"',
  );
  assertTypeErrorMessage(
    () => defineUnknown({ application: { routes: "./routes" } }),
    'config.application contains unknown key "routes"',
  );
  assertTypeErrorMessage(
    () => defineUnknown({ gateway: { worker: {} } }),
    'config.gateway contains unknown key "worker"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { listener: { reusePort: true } },
      }),
    'config.gateway.listener contains unknown key "reusePort"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { hypervisor: { target: "http://worker" } },
      }),
    'config.gateway.hypervisor contains unknown key "target"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { edge: { cors: { origins: "*", predicate: () => true } } },
      }),
    'config.gateway.edge.cors contains unknown key "predicate"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { edge: { static: { root: ".", contentType: () => "" } } },
      }),
    'config.gateway.edge.static contains unknown key "contentType"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { edge: { static: { root: ".", fallback: "../secret" } } },
      }),
    "config.gateway.edge.static.fallback must not contain empty or traversal segments",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            devProxy: {
              upstream: "http://localhost:5173",
              headers: { authorization: "secret" },
            },
          },
        },
      }),
    'config.gateway.edge.devProxy contains unknown key "headers"',
  );
});

test("v0.20 config rejects unknown local worker transports", () => {
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { workerTransport: "events" },
      }),
    'config.gateway.workerTransport must be "in-process" or "websocket"',
  );
});

test("v0.21 config validates local Worker capacity", () => {
  assertTypeErrorMessage(
    () => defineUnknown({ gateway: { workerCapacity: 0 } }),
    "config.gateway.workerCapacity must be a positive safe integer",
  );
  assertTypeErrorMessage(
    () => defineUnknown({ gateway: { workerCapacity: 1.5 } }),
    "config.gateway.workerCapacity must be a positive safe integer",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          workerCapacity: 3,
          hypervisor: { maxWorkerCapacity: 2 },
        },
      }),
    "config.gateway.workerCapacity must not exceed config.gateway.hypervisor.maxWorkerCapacity",
  );
  assert.deepStrictEqual(
    defineConfig({
      gateway: { hypervisor: { maxWorkerCapacity: 2 } },
    }).gateway.workerCapacity,
    2,
  );
});

test("v0.20 config rejects functions, nulls, and non-plain data", () => {
  assertTypeErrorMessage(
    () => defineUnknown(() => ({})),
    "config must be a plain object; received function",
  );
  assertTypeErrorMessage(
    () => defineUnknown(Object.create(null)),
    "config must be a plain object; received object",
  );
  assertTypeErrorMessage(
    () => defineUnknown({ application: new Date(0) }),
    "config.application must be a plain object; received object",
  );
  assertTypeErrorMessage(
    () => defineUnknown({ gateway: { listener: null } }),
    "config.gateway.listener must be a plain object; received null",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { listener: { port: () => 8_000 } },
      }),
    "config.gateway.listener.port must be an integer between 0 and 65535",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { edge: { cors: {} } },
      }),
    "config.gateway.edge.cors.origins is required",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: { cors: { origins: () => true } },
        },
      }),
    "config.gateway.edge.cors.origins must be an array of strings",
  );

  const accessor = {};
  Object.defineProperty(accessor, "gateway", {
    enumerable: true,
    get: () => ({}),
  });
  assertTypeErrorMessage(
    () => defineUnknown(accessor),
    "config.gateway must be an enumerable data property",
  );
});

test("v0.20 config rejects invalid paths, ports, hosts, and URLs", () => {
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        application: { routesRoot: "https://example.com/routes" },
      }),
    "config.application.routesRoot must be a local filesystem path or file: URL without a query or fragment",
  );
  for (const basePath of [
    "",
    "api",
    "/api/",
    "//api",
    "/api//v1",
    "/api/../v1",
    "/api%2Fv1",
    "/café",
  ]) {
    assertTypeErrorMessage(
      () =>
        defineUnknown({
          application: { basePath },
        }),
      'config.application.basePath must be "/" or a canonical absolute path of unescaped ASCII segments without a trailing slash',
    );
  }
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        application: { factory: "https://example.com/application.ts" },
      }),
    "config.application.factory must be a local filesystem path or file: URL without a query or fragment",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        application: { factory: "./application.js" },
      }),
    "config.application.factory must reference a local .ts module",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { listener: { port: -1 } },
      }),
    "config.gateway.listener.port must be an integer between 0 and 65535",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: { listener: { hostname: "http://localhost" } },
      }),
    "config.gateway.listener.hostname must be a bare hostname or IP address",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            static: { root: "https://example.com/assets" },
          },
        },
      }),
    "config.gateway.edge.static.root must be a local filesystem path or file: URL without a query or fragment",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            cors: { origins: ["https://example.com/path"] },
          },
        },
      }),
    'config.gateway.edge.cors.origins must contain serialized HTTP(S) origins or "null"',
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            devProxy: { upstream: "/vite" },
          },
        },
      }),
    "config.gateway.edge.devProxy.upstream must be an absolute HTTP(S) URL",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            devProxy: {
              upstream: "https://user:secret@example.com",
            },
          },
        },
      }),
    "config.gateway.edge.devProxy.upstream must not contain credentials",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            devProxy: {
              upstream: "http://localhost:5173",
              prefix: "vite",
            },
          },
        },
      }),
    "config.gateway.edge.devProxy.prefix must be an absolute URL path",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          edge: {
            devProxy: {
              upstream: "http://localhost:5173",
              stripPrefix: "yes",
            },
          },
        },
      }),
    "config.gateway.edge.devProxy.stripPrefix must be a boolean",
  );
});

test("v0.21 config delegates Hypervisor bounds and relationships", () => {
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          hypervisor: {
            heartbeatIntervalMs: 10,
            leaseTimeoutMs: 10,
          },
        },
      }),
    "leaseTimeoutMs must be greater than heartbeatIntervalMs",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          hypervisor: { path: "/workers/connect" },
        },
      }),
    'config.gateway.hypervisor contains unknown key "path"',
  );
});

test("v0.20 config keeps manifests, credentials, providers, and logging separate", () => {
  for (const key of [
    "workers",
    "bootstrap",
    "credentials",
    "providers",
    "secrets",
    "logging",
  ]) {
    assertTypeErrorMessage(
      () => defineUnknown({ [key]: {} }),
      `config contains unknown key "${key}"`,
    );
  }
});
