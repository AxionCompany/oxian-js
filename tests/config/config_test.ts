import {
  assertEquals,
  assertInstanceOf,
  assertNotStrictEquals,
  assertThrows,
} from "@std/assert";
import { DEFAULT_OXIAN_CONFIG, defineConfig } from "../../src/config/config.ts";
import type { OxianConfig } from "../../src/config/types.ts";

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assertEquals(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

function assertTypeErrorMessage(
  run: () => unknown,
  message: string,
): void {
  try {
    run();
    throw new Error("expected callback to throw");
  } catch (error) {
    assertInstanceOf(error, TypeError);
    assertEquals(error.message, message);
  }
}

const defineUnknown = defineConfig as (
  input: unknown,
) => OxianConfig;

Deno.test("v0.20 config exposes immutable, implemented-only defaults", () => {
  const config = defineConfig({});

  assertEquals(config, DEFAULT_OXIAN_CONFIG);
  assertEquals(config.application.routesRoot, "./routes");
  assertEquals(config.application.basePath, "/");
  assertEquals(config.application.factory, undefined);
  assertEquals(config.gateway.listener, {
    hostname: "127.0.0.1",
    port: 8_000,
  });
  assertEquals(
    config.gateway.hypervisor.workerPath,
    "/_oxian/workers/connect",
  );
  assertEquals(config.gateway.edge, undefined);
  assertDeepFrozen(config);

  assertThrows(
    () => {
      (config.gateway.listener as { port: number }).port = 9_000;
    },
    TypeError,
  );
});

Deno.test("v0.20 config permits listener port zero for ephemeral binding", () => {
  const config = defineConfig({
    gateway: { listener: { port: 0 } },
  });

  assertEquals(config.gateway.listener.port, 0);
});

Deno.test("v0.20 config normalizes data-only gateway and edge declarations", () => {
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
      hypervisor: {
        workerPath: "/workers/connect",
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

  assertEquals(config.application.routesRoot, "./api");
  assertEquals(config.application.basePath, "/api/v1");
  assertEquals(config.application.factory, "./application.ts");
  assertEquals(config.gateway.listener, {
    hostname: "localhost",
    port: 9_090,
  });
  assertEquals(config.gateway.hypervisor.workerPath, "/workers/connect");
  assertEquals(config.gateway.hypervisor.heartbeatIntervalMs, 2_000);
  assertEquals(config.gateway.edge?.cors, {
    origins: ["https://example.com"],
    methods: ["GET", "POST"],
    headers: ["x-request-id"],
    exposeHeaders: ["x-trace-id"],
    credentials: true,
    maxAgeSeconds: 300,
  });
  assertEquals(config.gateway.edge?.static, {
    root: "./public",
    prefix: "/assets",
    index: ["index.html", "home.html"],
    cacheControl: "public, max-age=60",
    fallthrough: false,
  });
  assertEquals(config.gateway.edge?.devProxy, {
    upstream: "http://127.0.0.1:5173/",
    prefix: "/vite",
    stripPrefix: true,
    forwardHost: true,
  });
  assertNotStrictEquals(config.gateway.edge?.cors?.methods, methods);
  assertNotStrictEquals(config.gateway.edge?.cors?.headers, headers);
  assertEquals(methods, ["get", "GET", "post"]);
  assertEquals(headers, ["X-Request-ID", "x-request-id"]);
  assertDeepFrozen(config);
});

Deno.test("v0.20 config rejects unknown keys at every owned boundary", () => {
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

Deno.test("v0.20 config rejects functions, nulls, and non-plain data", () => {
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

Deno.test("v0.20 config rejects invalid paths, ports, hosts, and URLs", () => {
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        application: { routesRoot: "https://example.com/routes" },
      }),
    "config.application.routesRoot must be a local filesystem path or file: URL without a query or fragment",
  );
  for (
    const basePath of [
      "",
      "api",
      "/api/",
      "//api",
      "/api//v1",
      "/api/../v1",
      "/api%2Fv1",
      "/café",
    ]
  ) {
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

Deno.test("v0.20 config delegates Hypervisor bounds and relationships", () => {
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
          hypervisor: { workerPath: "/workers/" },
        },
      }),
    "workerPath must be an absolute path without a trailing slash, query, fragment, or backslash, and must be URL-canonical without dot segments or an authority",
  );
  assertTypeErrorMessage(
    () =>
      defineUnknown({
        gateway: {
          hypervisor: { workerPath: null },
        },
      }),
    "config.gateway.hypervisor.workerPath must not be null",
  );
});

Deno.test("v0.20 config keeps manifests, credentials, providers, and logging separate", () => {
  for (
    const key of [
      "workers",
      "bootstrap",
      "credentials",
      "providers",
      "secrets",
      "logging",
    ]
  ) {
    assertTypeErrorMessage(
      () => defineUnknown({ [key]: {} }),
      `config contains unknown key "${key}"`,
    );
  }
});
