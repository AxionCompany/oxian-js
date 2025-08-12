import type { Context, Data, Middleware } from "../core/types.ts";
import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";

export async function runMiddlewares(files: URL[], data: Data, context: Context, loaders?: Loader[]): Promise<{ data: Data; context: Context }> {
  let currentData = { ...data };
  let currentContext = { ...context } as Context;

  for (const fileUrl of files) {
    const mod = await importModule(fileUrl, loaders ?? [], 60_000);
    const mw = ((mod as any).default ?? (mod as any).middleware) as unknown;
    if (typeof mw === "function") {
      const result = await (mw as Middleware)(currentData, currentContext);
      if (result && typeof result === "object") {
        if (result.data && typeof result.data === "object") currentData = { ...currentData, ...(result.data as Data) };
        if (result.context && typeof result.context === "object") currentContext = { ...currentContext, ...(result.context as Partial<Context>) } as Context;
      }
    }
  }

  return { data: currentData, context: currentContext };
} 