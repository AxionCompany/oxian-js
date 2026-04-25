/// <reference lib="deno.ns" />
import { importModule } from "../src/resolvers/importer.ts";
import { composeDependencies } from "../src/runtime/dependencies.ts";
import { runInterceptorsBefore } from "../src/runtime/interceptors.ts";
import { runMiddlewares } from "../src/runtime/middlewares.ts";
import { createResponseController } from "../src/utils/response.ts";
import type { Context, Data } from "../src/core/index.ts";
import { createResolver } from "../src/resolvers/index.ts";
import { join, toFileUrl } from "@std/path";

// deno-lint-ignore no-explicit-any
const resolver = createResolver(undefined, {}) as any;

Deno.test("importModule loads local module via graph", async () => {
  const dir = await Deno.makeTempDir();
  const filePath = join(dir, "mod.ts");
  await Deno.writeTextFile(
    filePath,
    "export default (fw)=>({ val: 42 }); export const value = 7;",
  );
  const url = toFileUrl(filePath);

  // deno-lint-ignore no-explicit-any
  const mod = await importModule(url) as any;
  if (typeof mod.default !== "function") {
    throw new Error("default export not a function");
  }
  const result = await mod.default({});
  if (result.val !== 42) throw new Error("unexpected result from module");
});

Deno.test("composeDependencies loads local dependency via graph", async () => {
  const dir = await Deno.makeTempDir();
  const depPath = join(dir, "dep.ts");
  await Deno.writeTextFile(depPath, "export default ()=>({ dep: 5 });");
  const depUrl = toFileUrl(depPath);

  const files = {
    dependencyFiles: [depUrl],
    middlewareFiles: [] as URL[],
    interceptorFiles: [] as URL[],
    sharedFiles: [] as URL[],
  };
  // deno-lint-ignore no-explicit-any
  const deps = await composeDependencies(files, {}, resolver) as any;
  if (deps.dep !== 5) throw new Error("local dependency not loaded");
});

Deno.test("interceptors and middlewares load from local files via graph", async () => {
  const dir = await Deno.makeTempDir();
  const intPath = join(dir, "interceptors.ts");
  const mwPath = join(dir, "middleware.ts");
  await Deno.writeTextFile(
    intPath,
    "export async function beforeRun(data){ return { data: { k: (data.k||0)+1 } }; }",
  );
  await Deno.writeTextFile(
    mwPath,
    "export default (data)=>({ data: { k: (data.k||0)+10 } })",
  );
  const intUrl = toFileUrl(intPath);
  const mwUrl = toFileUrl(mwPath);

  const data: Data = {};
  const { controller } = createResponseController();
  const ctx: Context = {
    requestId: crypto.randomUUID(),
    request: {
      method: "GET",
      url: "https://local/test",
      headers: new Headers(),
      pathParams: {},
      queryParams: new URLSearchParams(),
      query: {},
      body: undefined,
      raw: new Request("https://local/test"),
    },
    dependencies: {},
    response: controller,
    oxian: { route: "/", startedAt: performance.now() },
  };
  const afterInt = await runInterceptorsBefore([intUrl], data, ctx, resolver);
  const afterMw = await runMiddlewares(
    [mwUrl],
    afterInt.data,
    afterInt.context,
    resolver,
  );
  // deno-lint-ignore no-explicit-any
  if ((afterMw.data as any).k !== 11) {
    throw new Error("interceptors/middleware from local not applied");
  }
});
