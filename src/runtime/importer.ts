import type { Loader } from "../loader/types.ts";
import { isAbsolute, toFileUrl, join } from "@std/path";

const inMemoryCache = new Map<string, Record<string, unknown>>();

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
    // In-memory cache for faster file loads
    if (inMemoryCache.has(rootSpecifier)) {
        return inMemoryCache.get(rootSpecifier) as Record<string, unknown>;
    }

    try {

        // For the final dynamic import, map github: scheme to @github/ prefix so import map can resolve
        let mod: Record<string, unknown>;
        
        if (rootSpecifier.startsWith("github:")) {
            const finalSpecifier = rootSpecifier.replace(/^github:\/*/, "@github/")
            const importDataUrl = `data:text/typescript;base64,${btoa(`export * from "${finalSpecifier}";`)}`;
            mod = await import(importDataUrl);
        } else {
            const finalSpecifier = rootSpecifier;
            mod = await import(finalSpecifier);
        }

        inMemoryCache.set(rootSpecifier, mod as Record<string, unknown>);

        return mod as Record<string, unknown>;
    } catch (e) {
        // module not found, set cache to empty object
        inMemoryCache.set(rootSpecifier, {});
        throw e;
    }
} 