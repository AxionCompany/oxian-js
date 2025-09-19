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
    const mod = await resolver.import(url);
    dependenciesFactoryCache.set(key, mod);
    return mod;
  };

  let composed: Record<string, unknown> = {};

  for (const fileUrl of [...files.dependencyFiles, ...(files.sharedFiles.length > 0 ? files.sharedFiles : [])]) {
    const mod = await resolveMod(fileUrl);
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
    }
  }

  return composed;
} 