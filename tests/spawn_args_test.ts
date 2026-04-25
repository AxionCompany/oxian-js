/**
 * Unit tests for the pure spawn-arg builder functions.
 *
 * These functions are extracted from the hypervisor's doSpawnWorker and
 * tested in isolation — no process spawning, no filesystem I/O beyond
 * a trivial mock resolver.
 */

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildImportMap,
  buildOtelEnv,
  buildPermissionArgs,
  buildReloadArgs,
  buildUnstableFlags,
  shouldReloadWorker,
} from "../src/hypervisor_plugin/spawn_args.ts";
import type { Resolver } from "../src/resolvers/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal resolver stub that echoes back file: URLs for resolve(). */
function stubResolver(): Resolver {
  return {
    scheme: "file:",
    canHandle: () => true,
    resolve: (input: string | URL) => {
      const s = typeof input === "string" ? input : input.toString();
      if (s.startsWith("file:") || s.startsWith("http:") || s.startsWith("https:")) {
        return Promise.resolve(new URL(s));
      }
      return Promise.resolve(new URL(`file:///project/${s}`));
    },
    stat: () => Promise.resolve({ isFile: true }),
    listDir: () => Promise.resolve([]),
    import: () => Promise.resolve({}),
    load: () => Promise.resolve(""),
  } as unknown as Resolver;
}

// ---------------------------------------------------------------------------
// buildUnstableFlags
// ---------------------------------------------------------------------------

Deno.test("buildUnstableFlags: empty array returns empty", () => {
  assertEquals(buildUnstableFlags([]), []);
});

Deno.test("buildUnstableFlags: undefined returns empty", () => {
  assertEquals(buildUnstableFlags(undefined), []);
});

Deno.test("buildUnstableFlags: maps flags correctly", () => {
  assertEquals(
    buildUnstableFlags(["kv", "net", "otel"]),
    ["--unstable-kv", "--unstable-net", "--unstable-otel"],
  );
});

// ---------------------------------------------------------------------------
// buildPermissionArgs
// ---------------------------------------------------------------------------

Deno.test("buildPermissionArgs: no perms returns -A", () => {
  assertEquals(buildPermissionArgs(undefined, undefined), ["-A"]);
});

Deno.test("buildPermissionArgs: boolean true -> --allow-<key>", () => {
  const args = buildPermissionArgs({ net: true, ffi: true }, undefined);
  assertEquals(args.includes("--allow-net"), true);
  assertEquals(args.includes("--allow-ffi"), true);
});

Deno.test("buildPermissionArgs: string value -> --allow-<key>=<value>", () => {
  const args = buildPermissionArgs({ read: "/tmp" }, undefined);
  assertEquals(args.includes("--allow-read=/tmp"), true);
});

Deno.test("buildPermissionArgs: array value -> --allow-<key>=<joined>", () => {
  const args = buildPermissionArgs({ net: ["localhost", "example.com"] }, undefined);
  assertEquals(args.includes("--allow-net=localhost,example.com"), true);
});

Deno.test("buildPermissionArgs: false -> --deny-<key>", () => {
  const args = buildPermissionArgs({ run: false }, undefined);
  assertEquals(args.includes("--deny-run"), true);
});

Deno.test("buildPermissionArgs: service overrides global (appended after)", () => {
  const args = buildPermissionArgs(
    { net: true },
    { net: ["localhost"] },
  );
  // Both appear — service args come after global
  assertEquals(args, ["--allow-net", "--allow-net=localhost"]);
});

// ---------------------------------------------------------------------------
// shouldReloadWorker
// ---------------------------------------------------------------------------

Deno.test("shouldReloadWorker: invalidateCacheAt (number) > lastLoad -> true", () => {
  assertEquals(
    shouldReloadWorker({
      invalidateCacheAt: 2000,
      lastLoadMs: 1000,
      hotReload: false,
    }),
    true,
  );
});

Deno.test("shouldReloadWorker: invalidateCacheAt (number) < lastLoad -> false", () => {
  assertEquals(
    shouldReloadWorker({
      invalidateCacheAt: 500,
      lastLoadMs: 1000,
      hotReload: true,
    }),
    false,
  );
});

Deno.test("shouldReloadWorker: invalidateCacheAt (Date) > lastLoad -> true", () => {
  assertEquals(
    shouldReloadWorker({
      invalidateCacheAt: new Date(2000),
      lastLoadMs: 1000,
    }),
    true,
  );
});

Deno.test("shouldReloadWorker: invalidateCacheAt (string) parsed", () => {
  const ts = new Date(2000).toISOString();
  assertEquals(
    shouldReloadWorker({
      invalidateCacheAt: ts,
      lastLoadMs: 1000,
    }),
    true,
  );
});

Deno.test("shouldReloadWorker: invalid string -> 0 -> not > lastLoad", () => {
  assertEquals(
    shouldReloadWorker({
      invalidateCacheAt: "not-a-date",
      lastLoadMs: 1000,
    }),
    false,
  );
});

Deno.test("shouldReloadWorker: no invalidateCacheAt, hotReload true -> true", () => {
  assertEquals(
    shouldReloadWorker({ lastLoadMs: 1000, hotReload: true }),
    true,
  );
});

Deno.test("shouldReloadWorker: no invalidateCacheAt, hotReload false -> false", () => {
  assertEquals(
    shouldReloadWorker({ lastLoadMs: 1000, hotReload: false }),
    false,
  );
});

// ---------------------------------------------------------------------------
// buildReloadArgs
// ---------------------------------------------------------------------------

Deno.test("buildReloadArgs: includes root and service config", async () => {
  const args = await buildReloadArgs({
    resolver: stubResolver(),
    serviceConfig: "https://example.com/config.json",
  });
  assertEquals(args.length, 1);
  const arg = args[0];
  assertEquals(arg.startsWith("--reload="), true);
  // Should contain the resolved root and the service config
  assertEquals(arg.includes("file:///project/"), true);
  assertEquals(arg.includes("https://example.com/config.json"), true);
});

Deno.test("buildReloadArgs: no service config -> only root", async () => {
  const args = await buildReloadArgs({
    resolver: stubResolver(),
  });
  assertEquals(args.length, 1);
  assertEquals(args[0].startsWith("--reload="), true);
});

// ---------------------------------------------------------------------------
// buildOtelEnv
// ---------------------------------------------------------------------------

Deno.test("buildOtelEnv: disabled -> empty", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: false },
    service: "test",
  });
  assertEquals(Object.keys(env).length, 0);
});

Deno.test("buildOtelEnv: no config -> empty", () => {
  const env = buildOtelEnv({ service: "test" });
  assertEquals(Object.keys(env).length, 0);
});

Deno.test("buildOtelEnv: enabled sets OTEL_DENO and service header", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: true },
    service: "my-app",
  });
  assertEquals(env.OTEL_DENO, "true");
  assertEquals(env.OTEL_EXPORTER_OTLP_HEADERS, "x-oxian-service=my-app");
  assertEquals(env.OTEL_RESOURCE_ATTRIBUTES, "oxian.service=my-app");
});

Deno.test("buildOtelEnv: serviceName propagated", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: true, serviceName: "svc" },
    service: "p",
  });
  assertEquals(env.OTEL_SERVICE_NAME, "svc");
});

Deno.test("buildOtelEnv: proxy port overrides endpoint", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: true, endpoint: "http://collector:4318" },
    otelProxy: { enabled: true, port: 9999 },
    service: "p",
  });
  assertEquals(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:9999");
});

Deno.test("buildOtelEnv: endpoint used when no proxy", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: true, endpoint: "http://collector:4318" },
    service: "p",
  });
  assertEquals(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://collector:4318");
});

Deno.test("buildOtelEnv: custom headers merged with service header", () => {
  const env = buildOtelEnv({
    otelConfig: {
      enabled: true,
      headers: { "Authorization": "Bearer tok" },
    },
    service: "p",
  });
  assertEquals(
    env.OTEL_EXPORTER_OTLP_HEADERS,
    "Authorization=Bearer tok,x-oxian-service=p",
  );
});

Deno.test("buildOtelEnv: resource attributes merged with service", () => {
  const env = buildOtelEnv({
    otelConfig: {
      enabled: true,
      resourceAttributes: { "service.version": "1.2.3" },
    },
    service: "p",
  });
  assertEquals(
    env.OTEL_RESOURCE_ATTRIBUTES,
    "service.version=1.2.3,oxian.service=p",
  );
});

Deno.test("buildOtelEnv: metricExportIntervalMs -> string", () => {
  const env = buildOtelEnv({
    otelConfig: { enabled: true, metricExportIntervalMs: 5000 },
    service: "p",
  });
  assertEquals(env.OTEL_METRIC_EXPORT_INTERVAL, "5000");
});

Deno.test("buildOtelEnv: otelProxy enabled without otelConfig.enabled", () => {
  const env = buildOtelEnv({
    otelConfig: {},
    otelProxy: { enabled: true, port: 4318 },
    service: "p",
  });
  assertEquals(env.OTEL_DENO, "true");
  assertEquals(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4318");
});

// ---------------------------------------------------------------------------
// buildImportMap
// ---------------------------------------------------------------------------

Deno.test("buildImportMap: merges framework + host, host wins", async () => {
  const result = await buildImportMap({
    frameworkImports: { "@std/path": "jsr:@std/path@1" },
    hostImports: { "@std/path": "jsr:@std/path@2", "my-lib": "jsr:my-lib@1" },
    libSrcBaseHref: "file:///lib/src/",
    resolver: stubResolver(),
  });
  // Host wins for @std/path
  assertEquals(result.imports["@std/path"], "jsr:@std/path@2");
  assertEquals(result.imports["my-lib"], "jsr:my-lib@1");
});

Deno.test("buildImportMap: oxian-js/ rewritten to libSrcBaseHref", async () => {
  const result = await buildImportMap({
    frameworkImports: { "oxian-js/": "./src/" },
    hostImports: {},
    libSrcBaseHref: "file:///lib/src/",
    resolver: stubResolver(),
  });
  assertEquals(result.imports["oxian-js/"], "file:///lib/src/");
});

Deno.test("buildImportMap: relative specifiers resolved via resolver", async () => {
  const result = await buildImportMap({
    frameworkImports: {},
    hostImports: { "local": "./lib/mod.ts" },
    libSrcBaseHref: "file:///lib/src/",
    resolver: stubResolver(),
  });
  // stubResolver turns "./lib/mod.ts" into "file:///project/lib/mod.ts"
  assertEquals(result.imports["local"], "file:///project/lib/mod.ts");
});

Deno.test("buildImportMap: scopes merged", async () => {
  const result = await buildImportMap({
    frameworkImports: {},
    frameworkScopes: { "/a/": { x: "jsr:x@1" } },
    hostImports: {},
    hostScopes: { "/b/": { y: "jsr:y@1" } },
    libSrcBaseHref: "file:///lib/src/",
    resolver: stubResolver(),
  });
  assertEquals(result.scopes["/a/"], { x: "jsr:x@1" });
  assertEquals(result.scopes["/b/"], { y: "jsr:y@1" });
});
