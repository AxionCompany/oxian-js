import type { PipelineFiles } from "./pipeline_discovery.ts";
import type { Resolver } from "../resolvers/index.ts";

const dependenciesFactoryCache = new Map<string, Record<string, unknown>>();

export async function composeDependencies(
  files: PipelineFiles,
  contextForFactory: Record<string, unknown> = {},
  resolver: Resolver,
  opts?: { allowShared?: boolean },
): Promise<Record<string, unknown>> {

  const resolveMod = async (url: URL): Promise<Record<string, unknown>> => {
    const key = url.toString();
    if (dependenciesFactoryCache.has(key)) return dependenciesFactoryCache.get(key) as Record<string, unknown>;
    try {
      const mod = await resolver.import(url);
      dependenciesFactoryCache.set(key, mod);
      return mod;
    } catch (e) {
      console.error('[dependencies] error', e);
      throw e;
    }
  };

  let composed: Record<string, unknown> = {};

  const modulesPromises = [];
  const fileUrls = [...files.dependencyFiles, ...(files.sharedFiles.length > 0 ? files.sharedFiles : [])];
  for (const fileUrl of fileUrls) {
    modulesPromises.push(resolveMod(fileUrl));
  }
  const [...modules] = await Promise.all(modulesPromises);
  let c = 0;
  for (const mod of modules) {
    const candidate = (mod as Record<string, unknown>);
    const factory = (candidate.default ?? (candidate as { dependencies?: unknown }).dependencies) as unknown;
    if (typeof factory === "function") {
      const result = await (factory as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>)(
        {
          ...(contextForFactory ? { ...contextForFactory } : {}),
          ...(opts?.allowShared !== false ? { env: Deno.env.toObject() } : {})
        }
      );
      composed = { ...composed, ...result };
    } else {
      console.error('[dependencies] error', { fileUrl: fileUrls[c], factory });
      throw new Error('Dependencies file did not export a function');
    }
    c++;
  }

  return composed;
} 