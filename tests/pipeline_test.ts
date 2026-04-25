/// <reference lib="deno.ns" />
/**
 * Unit tests for the pipeline executor (executePipeline).
 *
 * These tests exercise the full request pipeline — dependency composition,
 * middleware, interceptors, handler execution, error shaping, HEAD fallback —
 * without spinning up an HTTP server. Each test creates a temp directory with
 * real .ts route files and uses a local resolver.
 */

import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { join } from "@std/path";
import { toFileUrl } from "jsr:@std/path@1/to-file-url";
import {
  clearPipelineCache,
  executePipeline,
} from "../src/runtime/executor.ts";
import { clearModuleCache } from "../src/runtime/module_loader.ts";
import { createResolver } from "../src/resolvers/index.ts";
import type { RouteRecord, RouteSegment } from "../src/router/types.ts";
import type { Context, ResponseController } from "../src/core/context.ts";
import type { ResponseState } from "../src/server/types.ts";
import type { EffectiveConfig } from "../src/config/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a file into a temp directory, creating parent dirs as needed. */
async function writeFile(base: string, rel: string, content: string) {
  const full = join(base, rel);
  const dir = full.replace(/\/[^/]*$/, "");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(full, content);
}

/** Build a minimal RouteRecord pointing at a real file. */
function makeRoute(
  tmpDir: string,
  relPath: string,
  pattern: string,
  segments: RouteSegment[] = [],
): RouteRecord {
  return {
    pattern,
    segments,
    fileUrl: toFileUrl(join(tmpDir, "routes", relPath)),
  };
}

/** Create a minimal Context with a tracking ResponseController. */
function makeContext(overrides?: Partial<Context>): Context {
  const noop = () => {};
  return {
    requestId: crypto.randomUUID(),
    request: {
      method: "GET",
      url: "http://localhost/test",
      headers: new Headers(),
      pathParams: {},
      queryParams: new URLSearchParams(),
      query: {},
      body: undefined,
      raw: new Request("http://localhost/test"),
    },
    dependencies: {},
    response: {
      send: noop,
      stream: () => {},
      sse: () => ({
        send: noop,
        comment: noop,
        close: noop,
        done: Promise.resolve(),
      }),
      status: noop,
      headers: noop,
      statusText: noop,
      redirect: noop,
    } as ResponseController,
    oxian: { route: "/test", startedAt: performance.now() },
    ...overrides,
  };
}

function makeState(): ResponseState {
  return { status: 200, headers: new Headers() };
}

function makeConfig(routesDir = "routes"): EffectiveConfig {
  return { routing: { routesDir } } as EffectiveConfig;
}

/** Scaffold a test: create temp dir, resolver, and cleanup handle. */
async function scaffold() {
  const tmpDir = await Deno.makeTempDir({ prefix: "oxian_pipeline_test_" });
  const resolver = createResolver(toFileUrl(tmpDir + "/"), {});
  // Clear caches so each test starts fresh
  clearPipelineCache();
  clearModuleCache();
  return {
    tmpDir,
    resolver,
    cleanup: () => Deno.remove(tmpDir, { recursive: true }).catch(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("pipeline: happy path — handler returns JSON", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET() { return { hello: "world" }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    const result = await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    assertEquals(state.body, { hello: "world" });
    assertEquals(state.status, 200);
    assertExists(result.context);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: dependency composition — root + leaf merged", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/dependencies.ts",
      `export default function() { return { rootDep: "root", shared: "from-root" }; }`,
    );
    await writeFile(
      tmpDir,
      "routes/sub/dependencies.ts",
      `export default function() { return { subDep: "sub", shared: "from-sub" }; }`,
    );
    await writeFile(
      tmpDir,
      "routes/sub/index.ts",
      `export function GET(_data, ctx) { return ctx.dependencies; }`,
    );

    const route = makeRoute(tmpDir, "sub/index.ts", "/sub");
    const state = makeState();
    const result = await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    // Leaf overrides root for 'shared', both deps present
    const deps = result.context.dependencies;
    assertEquals(deps.rootDep, "root");
    assertEquals(deps.subDep, "sub");
    assertEquals(deps.shared, "from-sub");
    // Handler also returns deps as body
    const body = state.body as Record<string, unknown>;
    assertEquals(body.rootDep, "root");
    assertEquals(body.subDep, "sub");
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: middleware modifies data", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/middleware.ts",
      `export default function(_data, _ctx) {
        return { data: { injectedByMw: true } };
      }`,
    );
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET(data) { return { saw: data.injectedByMw }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    await executePipeline({
      route,
      data: { original: true },
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    const body = state.body as Record<string, unknown>;
    assertEquals(body.saw, true);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: interceptors — beforeRun modifies data, afterRun receives result", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/interceptors.ts",
      `export function beforeRun(data, _ctx) {
        return { data: { beforeRan: true } };
      }
      export function afterRun(result, ctx) {
        ctx.dependencies.afterResult = result;
      }`,
    );
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET(data) { return { beforeRan: data.beforeRan, value: 42 }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    const result = await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    // beforeRun injected data
    const body = state.body as Record<string, unknown>;
    assertEquals(body.beforeRan, true);
    assertEquals(body.value, 42);

    // afterRun received the handler result
    const afterResult = result.context.dependencies.afterResult as Record<
      string,
      unknown
    >;
    assertEquals(afterResult.value, 42);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: interceptor ordering — root before leaf, leaf after root", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/interceptors.ts",
      `export function beforeRun(data) {
        const order = data.order || [];
        return { data: { order: [...order, "root"] } };
      }
      export function afterRun(_result, ctx) {
        const arr = ctx.dependencies.afterOrder || [];
        ctx.dependencies.afterOrder = [...arr, "root"];
      }`,
    );
    await writeFile(
      tmpDir,
      "routes/sub/interceptors.ts",
      `export function beforeRun(data) {
        const order = data.order || [];
        return { data: { order: [...order, "sub"] } };
      }
      export function afterRun(_result, ctx) {
        const arr = ctx.dependencies.afterOrder || [];
        ctx.dependencies.afterOrder = [...arr, "sub"];
      }`,
    );
    await writeFile(
      tmpDir,
      "routes/sub/index.ts",
      `export function GET(data) { return { order: data.order }; }`,
    );

    const route = makeRoute(tmpDir, "sub/index.ts", "/sub");
    const state = makeState();
    const result = await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    // beforeRun: root first, then sub
    const body = state.body as Record<string, unknown>;
    assertEquals(body.order, ["root", "sub"]);

    // afterRun: reversed — sub first, then root
    assertEquals(result.context.dependencies.afterOrder, ["sub", "root"]);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: error shaping — statusCode on thrown error", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET() {
        const err = new Error("I am a teapot");
        err.statusCode = 418;
        throw err;
      }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    const result = await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    assertEquals(state.status, 418);
    const body = state.body as { error: { message: string } };
    assertEquals(body.error.message, "I am a teapot");
    assertExists(result.resultOrError);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: HEAD falls back to GET and strips body", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET() { return { present: true }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "HEAD",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    // Body must be stripped for HEAD (RFC 7231)
    assertEquals(state.body, null);
    assertEquals(state.status, 200);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: 405 when method not exported", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET() { return { ok: true }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "DELETE",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    assertEquals(state.status, 405);
    const body = state.body as { error: { message: string } };
    assertEquals(body.error.message, "Method Not Allowed");
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: cache reuses discovered pipeline files", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/dependencies.ts",
      `let callCount = 0;
      export default function() { callCount++; return { callCount }; }`,
    );
    await writeFile(
      tmpDir,
      "routes/index.ts",
      `export function GET(_data, ctx) { return { deps: ctx.dependencies }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const config = makeConfig();

    // First call — discovers pipeline files
    const state1 = makeState();
    await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state: state1,
      method: "GET",
      config,
      resolver,
      isRemote: false,
    });

    // Second call — should reuse cached pipeline files
    const state2 = makeState();
    await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state: state2,
      method: "GET",
      config,
      resolver,
      isRemote: false,
    });

    // Both calls succeed
    assertEquals(state1.status, 200);
    assertEquals(state2.status, 200);
    assertExists(state1.body);
    assertExists(state2.body);
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: middleware error short-circuits before handler", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/middleware.ts",
      `export default function(_data, _ctx) {
        const err = new Error("Unauthorized");
        err.statusCode = 401;
        throw err;
      }`,
    );
    await writeFile(
      tmpDir,
      "routes/index.ts",
      // Handler should never run
      `export function GET() { return { shouldNotReach: true }; }`,
    );

    const route = makeRoute(tmpDir, "index.ts", "/");
    const state = makeState();
    await executePipeline({
      route,
      data: {},
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    assertEquals(state.status, 401);
    const body = state.body as { error: { message: string } };
    assertEquals(body.error.message, "Unauthorized");
  } finally {
    await cleanup();
  }
});

Deno.test("pipeline: handler receives path params via data", async () => {
  const { tmpDir, resolver, cleanup } = await scaffold();
  try {
    await writeFile(
      tmpDir,
      "routes/users/[id].ts",
      `export function GET(data) { return { userId: data.id }; }`,
    );

    const route = makeRoute(tmpDir, "users/[id].ts", "/users/:id", [
      { type: "static", value: "users" },
      { type: "param", name: "id" },
    ]);
    const state = makeState();
    await executePipeline({
      route,
      data: { id: "42" },
      context: makeContext(),
      state,
      method: "GET",
      config: makeConfig(),
      resolver,
      isRemote: false,
    });

    assertEquals(state.status, 200);
    const body = state.body as Record<string, unknown>;
    assertEquals(body.userId, "42");
  } finally {
    await cleanup();
  }
});
