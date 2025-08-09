import { fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import { importModule } from "./importer.ts";
import { createLoaderManager } from "../loader/index.ts";

export type LoadedModule = Record<string, unknown>;

const moduleCache = new Map<string, LoadedModule>();

export function clearModuleCache() {
  moduleCache.clear();
}

async function getMtimeMs(fileUrl: URL): Promise<number | undefined> {
  try {
    const path = fromFileUrl(fileUrl);
    const s = await Deno.stat(path);
    return s.mtime?.getTime();
  } catch {
    return undefined;
  }
}

export async function loadRouteModule(fileUrl: URL): Promise<LoadedModule> {
  if (fileUrl.protocol !== "file:") {
    const lm = createLoaderManager(Deno.cwd());
    const loaders = lm.getLoaders();
    return await importModule(fileUrl, loaders);
  }
  const mtime = await getMtimeMs(fileUrl);
  const cacheKey = `${fileUrl.toString()}?v=${mtime ?? "0"}`;
  if (moduleCache.has(cacheKey)) {
    return moduleCache.get(cacheKey)!;
  }
  const href = `${fileUrl.toString()}?v=${mtime ?? "0"}`;
  const mod = await import(href);
  moduleCache.set(cacheKey, mod as LoadedModule);
  return mod as LoadedModule;
}

export function getHandlerExport(mod: LoadedModule, method: string): unknown {
  const upper = method.toUpperCase();
  if (upper in mod) return (mod as Record<string, unknown>)[upper];
  if ("default" in mod) return (mod as Record<string, unknown>)["default"];
  return undefined;
} 