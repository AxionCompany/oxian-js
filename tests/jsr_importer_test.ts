/// <reference lib="deno.ns" />
import { importModule } from "../src/runtime/importer.ts";
import type { Loader } from "../src/loader/types.ts";
import { composeDependencies } from "../src/runtime/dependencies.ts";
import { runInterceptorsBefore } from "../src/runtime/interceptors.ts";
import { runMiddlewares } from "../src/runtime/middlewares.ts";
import { createResponseController } from "../src/utils/response.ts";
import type { Context, Data } from "../src/core/types.ts";

Deno.test("importModule bundles https module", async () => {
  const url = new URL("https://example.com/mod.ts");
  const contentMap: Record<string, string> = {
    [url.toString()]: "export default (fw)=>({ val: 42 }); export const value = 7;",
  };
  const loader: Loader = {
    scheme: "github",
    canHandle: (u) => u.protocol === "https:",
    load: async (u) => ({ content: contentMap[u.toString()] ?? "export const noop=1;", mediaType: "ts" }),
  };
  const mod = await importModule(url, [loader]);
  if (typeof (mod as any).default !== "function") throw new Error("default export not a function");
  const result = await (mod as any).default({});
  if (result.val !== 42) throw new Error("unexpected result from bundled module");
});

Deno.test("composeDependencies loads remote dependency via bundler", async () => {
  const depUrl = new URL("https://example.com/dep.ts");
  const contentMap: Record<string, string> = {
    [depUrl.toString()]: "export default ()=>({ dep: 5 });",
  };
  const loader: Loader = {
    scheme: "github",
    canHandle: (u) => u.protocol === "https:",
    load: async (u) => ({ content: contentMap[u.toString()] ?? "export const noop=1;", mediaType: "ts" }),
  };
  const files = { dependencyFiles: [depUrl], middlewareFiles: [], interceptorFiles: [] };
  const deps = await composeDependencies(files, {}, [loader]);
  if ((deps as any).dep !== 5) throw new Error("remote dependency not loaded");
});

Deno.test("interceptors and middlewares load from https via bundler", async () => {
  const intUrl = new URL("https://example.com/interceptors.ts");
  const mwUrl = new URL("https://example.com/middleware.ts");
  const contentMap: Record<string, string> = {
    [intUrl.toString()]: "export async function beforeRun(data){ return { data: { k: (data.k||0)+1 } }; }",
    [mwUrl.toString()]: "export default (data)=>({ data: { k: (data.k||0)+10 } })",
  };
  const loader: Loader = {
    scheme: "github",
    canHandle: (u) => u.protocol === "https:",
    load: async (u) => ({ content: contentMap[u.toString()] ?? "export const noop=1;", mediaType: "ts" }),
  };
  const data: Data = {};
  const { controller, state } = createResponseController();
  const ctx: Context = {
    requestId: crypto.randomUUID(),
    request: { method: "GET", url: "https://local/test", headers: new Headers(), pathParams: {}, queryParams: new URLSearchParams(), query: {}, body: undefined, raw: new Request("https://local/test") },
    dependencies: {},
    response: controller,
    oxian: { route: "/", startedAt: performance.now() },
  };
  const afterInt = await runInterceptorsBefore([intUrl], data, ctx, [loader]);
  const afterMw = await runMiddlewares([mwUrl], afterInt.data, afterInt.context, [loader]);
  if ((afterMw.data as any).k !== 11) throw new Error("interceptors/middleware from https not applied");
}); 