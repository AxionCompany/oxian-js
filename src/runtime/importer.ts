import type { Loader } from "../loader/types.ts";
import { createCache } from "@deno/cache-dir";
import { createGraph } from "@deno/graph";
import { resolveLocalUrl } from "../loader/local.ts";
import { parse as parseJsonc } from "@std/jsonc/parse";
import { createImportMapResolver } from "../utils/import_map/index.ts";

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
            const parsed = isJsonc ? (parseJsonc(content) as Record<string, unknown>) : (JSON.parse(content) as Record<string, unknown>);
            const imports = (parsed["imports"] ?? undefined) as Record<string, string> | undefined;
            const scopes = (parsed["scopes"] ?? undefined) as Record<string, Record<string, string>> | undefined;
            const resolver = createImportMapResolver(baseUrl, imports, scopes);
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
    // debug: importModule call context
    // console.debug('importModule', url.toString(), { ttl: _ttlMs, root: projectRoot });
    console.log('importModule', url.toString(), { ttl: _ttlMs, root: projectRoot });
    const rootSpecifier = url.toString();
    const cache = createCache({ allowRemote: true, cacheSetting: "reload" });
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
            const res = await cache.load(specifier, isDynamic, "reload");
            if (res) return res as unknown as { kind: "module" | "external"; specifier: string; content?: string };
            return undefined as unknown as { kind: "module"; specifier: string; content: string };
        },
        cacheInfo: cache.cacheInfo,
        resolve: resolveFn,
    } as unknown as Record<string, unknown>);

    console.log('importModule', rootSpecifier);
    return await import(rootSpecifier);
} 