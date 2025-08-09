import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";
import type { PipelineFiles } from "./pipeline_discovery.ts";

const depsCache = new Map<string, Record<string, unknown>>();

export async function composeDependencies(
  files: PipelineFiles,
  contextForFactory: { makeDb?: unknown } = {},
  loaders?: Loader[],
): Promise<Record<string, unknown>> {
  const key = files.dependencyFiles.map((u) => u.toString()).join("|") || "none";
  if (depsCache.has(key)) return depsCache.get(key)!;

  let composed: Record<string, unknown> = {};
  for (const fileUrl of files.dependencyFiles) {
    const mod = fileUrl.protocol === "file:"
      ? await import(fileUrl.toString())
      : await importModule(fileUrl, loaders ?? []);
    const factory = (mod.default ?? (mod as any).dependencies) as unknown;
    if (typeof factory === "function") {
      const result = await (factory as (fw: unknown) => unknown)(contextForFactory);
      if (result && typeof result === "object") {
        composed = { ...composed, ...(result as Record<string, unknown>) };
      }
    }
  }
  depsCache.set(key, composed);
  return composed;
} 