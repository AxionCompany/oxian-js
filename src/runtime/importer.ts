import type { Loader } from "../loader/types.ts";
import { isAbsolute, toFileUrl, join } from "@std/path";
import { createCache } from "@deno/cache-dir";
import { createGraph } from "@deno/graph";
import { resolveLocalUrl } from "../loader/local.ts";
import { parse as parseJsonc } from "@std/jsonc/parse";
import { createImportMapResolver } from "../utils/import_map/index.ts";

const cachedResolverByRoot = new Map<string, ((specifier: string, referrer?: string) => string) | null>();

function sanitizeUrlForLog(input: string): string {
    try {
        const u = new URL(input);
        if (u.username || u.password) {
            u.username = "***";
            u.password = "***";
        }
        return u.toString();
    } catch {
        return input;
    }
}

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

function mapGithubLikeToRaw(input: string): string {
    try {
        const u = new URL(input);
        // github:owner/repo/path?ref=main -> raw
        if (u.protocol === "github:") {
            const parts = u.pathname.replace(/^\//, "").split("/");
            const owner = parts[0] ?? "";
            const repo = parts[1] ?? "";
            const path = parts.slice(2).join("/");
            const ref = u.searchParams.get("ref") ?? "main";
            const token = Deno.env.get("GITHUB_TOKEN");
            const basic = Deno.env.get("OXIAN_GITHUB_BASIC_URL") === "1" && token ? `https://x-access-token:${encodeURIComponent(token)}@raw.githubusercontent.com` : `https://raw.githubusercontent.com`;
            return `${basic}/${owner}/${repo}/${ref}/${path}`;
        }
        // https://github.com/owner/repo/tree/ref/path -> raw
        if (u.protocol === "https:" && u.hostname === "github.com") {
            const parts = u.pathname.replace(/^\//, "").split("/");
            const owner = parts[0] ?? "";
            const repo = parts[1] ?? "";
            const type = parts[2];
            const ref = parts[3] ?? "main";
            const rest = parts.slice(type ? 4 : 2).join("/");
            const token = Deno.env.get("GITHUB_TOKEN");
            const basic = Deno.env.get("OXIAN_GITHUB_BASIC_URL") === "1" && token ? `https://x-access-token:${encodeURIComponent(token)}@raw.githubusercontent.com` : `https://raw.githubusercontent.com`;
            return `${basic}/${owner}/${repo}/${ref}/${rest}`;
        }
        return input;
    } catch {
        return input;
    }
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

function normalizeToUrl(input: string | URL, projectRoot?: string): URL {
    if (input instanceof URL) return input;
    // If already a URL-like string
    try { return new URL(input as string); } catch { /* not a URL */ }
    const pathStr = input as string;
    // Absolute filesystem path (handles Windows drive letters)
    if (isAbsolute(pathStr)) {
        return toFileUrl(pathStr);
    }
    // Relative path: resolve against projectRoot or cwd
    const base = projectRoot ?? Deno.cwd();
    try {
        return new URL(pathStr, toFileUrl(isAbsolute(base) ? base : join(Deno.cwd(), base)).toString());
    } catch {
        // Fallback: join
        return toFileUrl(join(base, pathStr));
    }
}

export async function importModule(url: URL | string, loaders: Loader[], _ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    // debug: importModule call context (guarded by OXIAN_DEBUG)
    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        try { console.log('importModule', sanitizeUrlForLog((url as URL).toString()), { ttl: _ttlMs, root: projectRoot }); } catch { console.log('importModule', sanitizeUrlForLog(String(url)), { ttl: _ttlMs, root: projectRoot }); }
    }
    const asUrl = normalizeToUrl(url as string | URL, projectRoot);
    let rootSpecifier = asUrl.toString();
    // Dev-friendly cache busting for local files: append mtime as query param
    if (asUrl.protocol === "file:") {
        const mt = await mtimeForUrl(asUrl, loaders);
        const u = new URL(asUrl.toString());
        u.searchParams.set("v", String(mt ?? 0));
        rootSpecifier = u.toString();
    }
    const cache = createCache({ allowRemote: true, cacheSetting: "use" });
    const resolveFn = await getProjectImportResolver(loaders, projectRoot);

    await createGraph(rootSpecifier, {
        load: async (specifier: string, isDynamic?: boolean) => {
            // Resolve custom schemes like github: to a native URL so cache can store it under DENO_DIR
            const resolvedForCache = mapGithubLikeToRaw(specifier);
            const res = await cache.load(resolvedForCache, isDynamic, "use");
            if (res) return res as unknown as { kind: "module" | "external"; specifier: string; content?: string };
            return undefined as unknown as { kind: "module"; specifier: string; content: string };
        },
        cacheInfo: cache.cacheInfo,
        resolve: resolveFn,
    } as unknown as Record<string, unknown>);

    if (Deno.env.get("OXIAN_DEBUG") === "1") {
        console.log('importModule', sanitizeUrlForLog(rootSpecifier));
    }
    // For the final dynamic import, translate non-native schemes (e.g. github:) to a native URL
    const finalSpecifier = mapGithubLikeToRaw(rootSpecifier);
    return await import(finalSpecifier);
} 