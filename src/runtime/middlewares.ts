import type { Context, Data, Middleware } from "../core/types.ts";
import type { Loader } from "../loader/types.ts";
import type { OxianConfig } from "../config/types.ts";
import { importModule } from "./importer.ts";

function isMiddlewareObjectResult(input: unknown): input is { data?: Data; context?: Partial<Context> } {
  return typeof input === "object" && input !== null;
}

export async function runMiddlewares(files: URL[], data: Data, context: Context, loaders?: Loader[], config?: OxianConfig): Promise<{ data: Data; context: Context }> {
  let currentData = { ...data };
  let currentContext = { ...context } as Context;

  for (const fileUrl of files) {
    const mod = await importModule(fileUrl, loaders ?? [], 60_000);
    const modObj = mod as Record<string, unknown>;
    let mw: unknown = (modObj["default"] ?? modObj["middleware"]);
    if (typeof mw === "function") {
      if (config?.compatibility?.middlewareMode === "this") {
        mw = (mw as (...args: unknown[]) => unknown).bind(context.dependencies);
      } else if (config?.compatibility?.middlewareMode === "factory") {
        const produced = (mw as (deps: unknown) => unknown)(context.dependencies);
        if (typeof produced !== "function") {
          throw new Error("Middleware factory did not return a function");
        }
        mw = produced as (data: Data, context: Context) => unknown;
      } else if (config?.compatibility?.middlewareMode === "assign") {
        mw = Object.assign(mw as (data: Data, context: Context) => unknown, { ...context.dependencies });
      }
      let result: unknown = null;
      if (config?.compatibility?.useMiddlewareRequest) {
        const { request } = currentContext;
        // override Headers with headers object
        request.headers = Object.fromEntries(request.headers.entries()) as unknown as Headers;
        const res = await (mw as Middleware)(request as unknown as Data, currentContext);
        if (res && typeof res === "object" && "params" in (res as Record<string, unknown>)) {
          const withParams = res as Record<string, unknown>;
          result = { data: withParams["params"] };
        }
      } else {
        result = await (mw as Middleware)(currentData, currentContext);
      }
      if (isMiddlewareObjectResult(result)) {
        if (result.data && typeof result.data === "object") currentData = { ...currentData, ...(result.data as Data) };
        if (result.context && typeof result.context === "object") currentContext = { ...currentContext, ...(result.context as Partial<Context>) } as Context;
      }
    }
  }

  return { data: currentData, context: currentContext };
} 