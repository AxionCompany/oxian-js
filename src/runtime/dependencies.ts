import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";
import type { PipelineFiles } from "./pipeline_discovery.ts";

const depsCache = new Map<string, Record<string, unknown>>();

export async function composeDependencies(
  files: PipelineFiles,
  contextForFactory: { makeDb?: unknown } = {},
  loaders?: Loader[],
  opts?: { allowShared?: boolean },
): Promise<Record<string, unknown>> {
  const key = files.dependencyFiles.map((u) => u.toString()).join("|") + "|" + files.middlewareFiles.length + "|" + files.interceptorFiles.length + `|shared=${opts?.allowShared !== false}`;
  if (depsCache.has(key)) return depsCache.get(key)!;

  const resolveMod = async (url: URL) => await importModule(url, loaders ?? [], 60_000);

  let composed: Record<string, unknown> = {};
  // Support deprecated shared.(ts|js)
  if (opts?.allowShared !== false) {
    const sharedCandidates: URL[] = [];
    for (const base of [...files.dependencyFiles, ...files.middlewareFiles, ...files.interceptorFiles]) {
      const u = new URL("shared.ts", base);
      sharedCandidates.push(u);
      sharedCandidates.push(new URL("shared.js", base));
    }
    for (const u of sharedCandidates) {
      try {
        const mod = await resolveMod(u);
        const { logDeprecation } = await import("../logging/logger.ts");
        logDeprecation(`shared.* detected at ${u}. Please rename to dependencies.ts`);
        const factory = (mod as any).default ?? (mod as any).shared;
        if (typeof factory === "function") {
          const res = await factory(contextForFactory);
          if (res && typeof res === "object") composed = { ...composed, ...(res as Record<string, unknown>) };
        }
      } catch { /* ignore */ }
    }
  }

  for (const fileUrl of files.dependencyFiles) {
    const mod = await resolveMod(fileUrl);
    const factory = (mod as any).default ?? (mod as any).dependencies;
    if (typeof factory === "function") {
      const result = await factory(contextForFactory);
      if (result && typeof result === "object") {
        composed = { ...composed, ...(result as Record<string, unknown>) };
      }
    }
  }
  depsCache.set(key, composed);
  return composed;
} 