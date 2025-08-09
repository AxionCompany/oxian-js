import type { Context, Data, Interceptors } from "../core/types.ts";
import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";

export async function runInterceptorsBefore(files: URL[], data: Data, context: Context, loaders?: Loader[]): Promise<{ data: Data; context: Context }> {
  let currentData = { ...data };
  let currentContext = { ...context } as Context;

  for (const fileUrl of files) {
    const mod = fileUrl.protocol === "file:" ? await import(fileUrl.toString()) : await importModule(fileUrl, loaders ?? []);
    const before = (mod as Interceptors).beforeRun as Interceptors["beforeRun"];
    if (typeof before === "function") {
      const result = await before(currentData, currentContext);
      if (result && typeof result === "object") {
        if (result.data && typeof result.data === "object") currentData = { ...currentData, ...(result.data as Data) };
        if (result.context && typeof result.context === "object") currentContext = { ...currentContext, ...(result.context as Partial<Context>) } as Context;
      }
    }
  }

  return { data: currentData, context: currentContext };
}

export async function runInterceptorsAfter(files: URL[], resultOrError: unknown, context: Context, loaders?: Loader[]): Promise<void> {
  for (const fileUrl of [...files].reverse()) {
    const mod = fileUrl.protocol === "file:" ? await import(fileUrl.toString()) : await importModule(fileUrl, loaders ?? []);
    const after = (mod as Interceptors).afterRun as Interceptors["afterRun"];
    if (typeof after === "function") {
      await after(resultOrError, context);
    }
  }
} 