import type { Loader } from "../loader/types.ts";
import { bundle } from "jsr:@deno/emit@0.46.0";

const bundleCache = new Map<string, { code: string; expiresAt: number }>();

export async function bundleModule(entry: URL, loaders: Loader[], ttlMs = 60_000): Promise<string> {
  const loader = loaders.find((l) => l.canHandle(entry));
  if (!loader) throw new Error(`No loader for ${entry}`);
  const cacheKey = (loader.cacheKey?.(entry) ?? entry.toString()) + `|ttl=${ttlMs}`;
  const now = Date.now();
  const cached = bundleCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.code;

  try {
    const result = await bundle(entry.toString(), {
      load: async (specifier: string) => {
        const url = new URL(specifier);
        const ldr = loaders.find((l) => l.canHandle(url));
        if (!ldr) return undefined as unknown as { kind: "module"; specifier: string; content: string };
        const { content } = await ldr.load(url);
        return { kind: "module", specifier: url.toString(), content } as { kind: "module"; specifier: string; content: string };
      },
    } as unknown as Record<string, unknown>);
    const code = (result as unknown as { code?: string }).code;
    if (code && code.length > 0) {
      bundleCache.set(cacheKey, { code, expiresAt: now + ttlMs });
      return code;
    }
  } catch (_e) {
    // fall through to direct-load fallback below
  }

  // Fallback: direct module content (sufficient for single-file modules without imports)
  const { content } = await loader.load(entry);
  bundleCache.set(cacheKey, { code: content, expiresAt: now + ttlMs });
  return content;
} 