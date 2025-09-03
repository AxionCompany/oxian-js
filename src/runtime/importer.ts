import type { Loader } from "../loader/types.ts";
import { isAbsolute as pathIsAbsolute, toFileUrl, join } from "@std/path";
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

async function mtimeForUrl(url: URL, loaders: Loader[]): Promise<number | undefined> {
    try {
        const active = loaders.find((l) => l.canHandle(url));
        const st = await (active?.stat?.(url) ?? Promise.resolve(undefined));
        return (st as { mtime?: number } | undefined)?.mtime;
    } catch {
        return undefined;
    }
}

export async function importModule(url: URL, loaders: Loader[], _ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    // debug: importModule call context (guarded by OXIAN_DEBUG)
    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        console.log('importModule(version)', { importer: import.meta.url });
        console.log('importModule(input)', url?.toString?.() ?? String(url), { typeof: typeof url, isUrl: url instanceof URL, ttl: _ttlMs, root: projectRoot });
    }
    // Normalize incoming specifier to a proper URL (Windows-safe)
    let rootSpecifier = "";
    let resolvedUrl: URL | undefined = undefined;
    // If we got a URL object, use it directly; otherwise coerce to file URL/path
    if (url instanceof URL) {
        resolvedUrl = url;
    } else {
        let raw = (url as unknown as { toString(): string })?.toString?.() ?? String(url as unknown);
        if (/^[a-zA-Z]:[\\\/]/.test(raw) || pathIsAbsolute(raw)) {
            resolvedUrl = toFileUrl(raw);
        } else {
            try { resolvedUrl = new URL(raw); } catch {
                if (projectRoot) {
                    const abs = pathIsAbsolute(projectRoot) ? join(projectRoot, raw) : join(Deno.cwd(), projectRoot, raw);
                    resolvedUrl = toFileUrl(abs);
                }
            }
        }
    }
    if (resolvedUrl) {
        // Dev-friendly cache busting for local files: append mtime as query param
        if (resolvedUrl.protocol === "file:") {
            const mt = await mtimeForUrl(resolvedUrl, loaders);
            const u = new URL(resolvedUrl.toString());
            u.searchParams.set("v", String(mt ?? 0));
            rootSpecifier = u.toString();
        } else {
            rootSpecifier = resolvedUrl.toString();
        }
    }
    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        console.log('importModule(normalized)', { resolved: resolvedUrl?.toString?.() ?? null, rootSpecifier });
    }
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

    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        console.log('importModule', rootSpecifier);
    }
    return await import(rootSpecifier);
} 