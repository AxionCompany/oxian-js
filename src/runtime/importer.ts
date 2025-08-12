import type { Loader } from "../loader/types.ts";
import { createCache } from "@deno/cache-dir";
import { createGraph } from "@deno/graph";
import { resolveLocalUrl } from "../loader/local.ts";
import { parse as parseJsonc } from "@std/jsonc/parse";
import { parseFromJson } from "https://deno.land/x/import_map@v0.18.3/mod.ts";

const cachedResolverByRoot = new Map<string, ((specifier: string, referrer?: string) => string) | null>();


async function getProjectImportResolver(loaders: Loader[], projectRoot?: string): Promise<((specifier: string, referrer?: string) => string) | undefined> {
    const root = projectRoot ?? Deno.cwd();
    if (cachedResolverByRoot.has(root)) return cachedResolverByRoot.get(root) ?? undefined;

    const candidates = ["deno.json", "deno.jsonc"];
    for (const name of candidates) {
        try {
            const baseUrl = resolveLocalUrl(root, name);
            const ldr = loaders.find((l) => l.canHandle(baseUrl));
            if (!ldr) continue;
            const { content } = await ldr.load(baseUrl);
            const isJsonc = name.endsWith(".jsonc");
            const jsonText = isJsonc ? JSON.stringify(parseJsonc(content)) : content;
            const resolved = await parseFromJson(baseUrl, jsonText);
            const resolver = resolved.resolve.bind(resolved) as (specifier: string, referrer?: string) => string;
            cachedResolverByRoot.set(root, resolver);
            return resolver;
        } catch {
            // try next candidate
        }
    }
    cachedResolverByRoot.set(root, null);
    return undefined;
}

export async function importModule(url: URL, loaders: Loader[], _ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const rootSpecifier = url.toString();
    const cache = createCache({ allowRemote: true, cacheSetting: "use" });
    const resolveFn = await getProjectImportResolver(loaders, projectRoot);

    await createGraph(rootSpecifier, {
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
        cacheInfo: cache.cacheInfo,
        resolve: resolveFn,
    } as unknown as Record<string, unknown>);

    return await import(rootSpecifier);
} 