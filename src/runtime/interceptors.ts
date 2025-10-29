import type { Context, Data, Interceptors } from "../core/index.ts";
import type { Resolver } from "../resolvers/index.ts";

const interceptorsCache = new Map<string, Record<string, unknown>>();

const resolveMod = async (
  url: URL,
  resolver: Resolver,
): Promise<Record<string, unknown>> => {
  const key = url.toString();
  if (interceptorsCache.has(key)) {
    return interceptorsCache.get(key) as Record<string, unknown>;
  }
  const mod = await resolver.import(url);
  interceptorsCache.set(key, mod);
  return mod;
};

export async function runInterceptorsBefore(
  files: URL[],
  data: Data,
  context: Context,
  resolver: Resolver,
): Promise<{ data: Data; context: Context }> {
  let currentData = { ...data };
  let currentContext = { ...context } as Context;

  const modulesPromises = [];
  for (const fileUrl of files) {
    modulesPromises.push(resolveMod(fileUrl, resolver));
  }
  const [...modules] = await Promise.all(modulesPromises);
  for (const mod of modules) {
    const before = (mod as Interceptors).beforeRun as Interceptors["beforeRun"];
    if (typeof before === "function") {
      const result = await before(currentData, currentContext);
      if (result && typeof result === "object") {
        if (result.data && typeof result.data === "object") {
          currentData = { ...currentData, ...(result.data as Data) };
        }
        if (result.context && typeof result.context === "object") {
          currentContext = {
            ...currentContext,
            ...(result.context as Partial<Context>),
          } as Context;
        }
      }
    }
  }

  return { data: currentData, context: currentContext };
}

export async function runInterceptorsAfter(
  files: URL[],
  resultOrError: unknown,
  context: Context,
  resolver: Resolver,
): Promise<void> {
  for (const fileUrl of [...files].reverse()) {
    const mod = await resolveMod(fileUrl, resolver);
    const after = (mod as Interceptors).afterRun as Interceptors["afterRun"];
    if (typeof after === "function") {
      await after(resultOrError, context);
    }
  }
}
