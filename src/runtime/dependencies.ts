import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";
import type { PipelineFiles } from "./pipeline_discovery.ts";

// Memoize composed deps per chain key (existing)
const depsCache = new Map<string, Record<string, unknown>>();
// New: memoize individual dependency factory results per file URL
const factoryCache = new Map<string, Record<string, unknown>>();

export async function composeDependencies(
  files: PipelineFiles,
  contextForFactory: Record<string, unknown> = {},
  loaders?: Loader[],
  opts?: { allowShared?: boolean },
): Promise<Record<string, unknown>> {
  function siblingUrl(baseFile: URL, name: string): URL {
    if (baseFile.protocol === "github:") {
      const search = baseFile.search || "";
      const path = baseFile.pathname.replace(/\/[^\/]*$/, "/");
      const abs = `github:${(path + name).replace(/^\//, "")}${search}`;
      return new URL(abs);
    }
    const baseObj = new URL(baseFile.toString());
    baseObj.pathname = baseObj.pathname.replace(/\/[^\/]*$/, "/");
    return new URL(name, baseObj);
  }
  async function getMtime(url: URL): Promise<number | undefined> {
    // Optimization: avoid remote mtime checks which are expensive (GitHub API); rely on in-process cache
    if (url.protocol !== "file:") return undefined;
    try {
      const active = (loaders ?? []).find((l) => l.canHandle(url));
      const st = await (active?.stat?.(url) ?? Promise.resolve(undefined));
      return (st as { mtime?: number } | undefined)?.mtime;
    } catch {
      return undefined;
    }
  }

  const depKeyParts = await Promise.all(files.dependencyFiles.map(async (u) => `${u.toString()}@${(await getMtime(u)) ?? 0}`));
  const key = depKeyParts.join("|") + "|" + files.middlewareFiles.length + "|" + files.interceptorFiles.length + `|shared=${opts?.allowShared !== false}`;
  if (depsCache.has(key)) return depsCache.get(key)!;

  const resolveMod = async (url: URL): Promise<Record<string, unknown>> => await importModule(url, loaders ?? [], 60_000);

  let composed: Record<string, unknown> = {};

  for (const fileUrl of [...files.dependencyFiles, ...(files.sharedFiles.length > 0 ? files.sharedFiles : [])]) {
    const mod = await resolveMod(fileUrl);
    const candidate = (mod as Record<string, unknown>);
    const factory = (candidate.default ?? (candidate as { dependencies?: unknown }).dependencies) as unknown;
    if (typeof factory === "function") {
      const mt = await getMtime(fileUrl);
      const cacheKey = `${fileUrl.toString()}?v=${mt ?? 0}`;
      if (!factoryCache.has(cacheKey)) {
        const result = await (factory as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)(
          {
            ...(contextForFactory ? { ...contextForFactory } : {}),
            ...(opts?.allowShared !== false ? { env: Deno.env.toObject() } : {})
          }
        );
        if (result && typeof result === "object") factoryCache.set(cacheKey, result as Record<string, unknown>);
      }
      const saved = factoryCache.get(cacheKey);
      if (saved) composed = { ...composed, ...saved };
    }
  }
  depsCache.set(key, composed);
  return composed;
} 