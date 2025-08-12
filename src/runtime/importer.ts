import type { Loader } from "../loader/types.ts";
import { createCache } from "@deno/cache-dir";
import { createGraph } from "@deno/graph";

export async function importModule(url: URL, loaders: Loader[], _ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const rootSpecifier = url.toString();
    const cache = createCache({ allowRemote: true, cacheSetting: "use" });

    const graph = await createGraph(rootSpecifier, {
        // first try our custom loaders; fall back to deno cache
        load: async (specifier: string, isDynamic?: boolean) => {
            try {
                const parsed = new URL(specifier);
                const ldr = loaders.find((l) => l.canHandle(parsed));
                if (ldr) {
                    const { content } = await ldr.load(parsed);
                    return { kind: "module", specifier: parsed.toString(), content } as { kind: "module"; specifier: string; content: string };
                }
            } catch {
                // not a URL, let cache try
            }
            const res = await cache.load(specifier, isDynamic, "use");
            if (res) return res as unknown as { kind: "module" | "external"; specifier: string; content?: string };
            return undefined as unknown as { kind: "module"; specifier: string; content: string };
        },
        importMap: undefined,
    } as unknown as Record<string, unknown>);

    // With the graph constructed, do a regular import of the root. Deno will resolve from cache.
    return await import(rootSpecifier);
} 