import { isAbsolute, toFileUrl, join } from "@std/path";
import { importModule } from "./importer.ts";

const inMemoryCache = new Map<string, Record<string, unknown>>();

export function parseGithubUrl(specifier?: string, baseUrl: URL): { owner: string; repo: string; ref: string; path: string } | null {
    // Prioritize specifier full URL if it's raw.githubusercontent.com over github.com
    if (specifier?.protocol === "https:" && specifier?.hostname === "raw.githubusercontent.com") {
        const input = specifier;
        const parts = input.pathname.split("/").filter(Boolean);
        const [owner, repo, ref, ...path] = parts;
        if (!owner || !repo || !ref || !path) return null;
        return { owner, repo, ref, path: path.join("/") };
    }
    // Parse github: base URLs
    if (baseUrl.protocol === "github:") {
        const input = new URL(`https://github.com/${baseUrl.pathname}/${specifier}?${baseUrl.searchParams.toString()}`);
        const [owner, repo, ...rest] = input.pathname.split("/").filter(Boolean);
        const path = rest.join("/");
        const ref = input.searchParams.get("ref") ?? "main";
        return owner && repo ? { owner, repo, ref, path } : null;
    }
    // Parse github.com base URLs
    if (baseUrl.protocol === "https:" && baseUrl.hostname === "github.com") {
        const input = new URL(specifier, baseUrl);
        const parts = input.pathname.split("/").filter(Boolean);
        const [owner, repo, _type, ref, ...rest] = parts;
        if (!owner || !repo) return null;
        const path = rest.join("/");
        const effectiveRef = ref ?? "main";
        return { owner, repo, ref: effectiveRef, path };
    }
    // Parse raw.githubusercontent.com base URLs
    if (baseUrl.protocol === "https:" && baseUrl.hostname === "raw.githubusercontent.com") {
        const input = new URL(specifier, baseUrl);
        const parts = input.pathname.split("/").filter(Boolean);
        const [owner, repo, ref, path] = parts;
        if (!owner || !repo || !ref || !path) return null;
        return { owner, repo, ref, path };
    }
    // Return null if no match
    return null;
}

interface Resolver {
    listDir: (specifier: string) => Promise<string[]>;
    stat: (specifier: string) => Promise<{ isFile: boolean }>;
    resolve: (specifier: string) => Promise<URL>;
}

// Main entry point for creating a resolver
export function createResolver(baseUrl: URL | string, opts: { tokenEnv?: string, tokenValue?: string, ttlMs?: number }): Resolver {
    let type: "local" | "github";

    try {
        if (baseUrl && !(baseUrl instanceof URL)) {
            baseUrl = new URL(baseUrl);
        }
    } catch { /* ignore */ }

    if (baseUrl?.protocol) {
        if (baseUrl instanceof URL) {
            switch (baseUrl.protocol) {
                case "file:":
                    type = "local";
                    break;
                case "github:":
                    type = "github";
                    break;
                case "http:":
                case "https:":
                    type = "http";
                    break;
            }
        }
    } else { type = "local" }

    const resolverMap = {
        local: createLocalResolver(),
        http: createHttpResolver(baseUrl),
        github: createGithubResolver(baseUrl, { tokenEnv: opts.tokenEnv, tokenValue: opts.tokenValue }),
    };

    const baseKey = baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl ?? Deno.cwd());
    const cacheKey = (op: string, spec: string | URL) => `${op}::${baseKey}::${spec?.toString()}`;

    const resolver = {
        resolve: async (specifier: string | URL) => {
            const key = cacheKey("resolve", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as URL;
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}, ${specifier?.toString()}, ${baseUrl.toString()}`);
            const url = await resolverMap[type].resolve(specifier, baseUrl);
            inMemoryCache.set(key, url);
            return url;
        },
        listDir: async (specifier: string | URL) => {
            const key = cacheKey("listDir", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as string[];
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}, ${specifier?.toString()}, ${baseUrl.toString()}`);
            const listDir = await resolverMap[type].listDir(await resolver.resolve(specifier, baseUrl));
            const array = Array.isArray(listDir) ? listDir : Array.from(listDir as unknown as Iterable<string>);
            inMemoryCache.set(key, array);
            return array;
        },
        stat: async (specifier: string | URL) => {
            const key = cacheKey("stat", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as { isFile: boolean };
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}`);
            const stat = await resolverMap[type].stat(await resolver.resolve(specifier, baseUrl));
            inMemoryCache.set(key, stat);
            return stat;
        },
        import: async (specifier: string | URL) => {
            const key = cacheKey("import", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as Record<string, unknown>;
            const mod = await importModule(await resolver.resolve(specifier), opts.ttlMs);
            inMemoryCache.set(key, mod);
            return mod;
        }
    }
    return resolver;
}

// Resolver for local files
export function createLocalResolver(baseUrl?: URL): Resolver {
    return {
        scheme: "local",
        canHandle: (specifier: string) => Deno.stat(specifier).then(() => true).catch(() => false),
        resolve(specifier?: string | URL) {
            if (specifier?.startsWith?.("file:")) return Promise.resolve(new URL(specifier));
            if ((specifier as URL)?.protocol === "file:") return Promise.resolve(specifier as URL);
            const url = isAbsolute(specifier as string)
                ? toFileUrl(specifier as string)
                : toFileUrl(join(baseUrl?.toString() ?? Deno.cwd(), specifier as string));
            return Promise.resolve(url);
        },
        listDir(URLspecifier: URL) {
            const path = URLspecifier.toString().replace("file://", "");
            const entries = Array.from(Deno.readDirSync(path));
            return Promise.resolve(entries.map((entry) => entry.name));
        },
        stat(URLspecifier: URL) {
            const info = Deno.statSync(URLspecifier.toString().replace("file://", ""));
            return Promise.resolve(info as unknown as { isFile: boolean });
        }
    }
}

// Resolver for HTTP(s)
export function createHttpResolver(baseUrl: URL): Resolver {
    return {
        scheme: "http",
        canHandle: (specifier: string) => specifier.startsWith("http:") || specifier.startsWith("https:"),
        resolve(specifier?: string | URL) {
            if ((specifier as string)?.startsWith?.("http:") || (specifier as string)?.startsWith?.("https:")) return Promise.resolve(new URL(specifier as string));
            if ((specifier as URL)?.protocol === "http:" || (specifier as URL)?.protocol === "https:") return Promise.resolve(specifier as URL);
            return Promise.resolve(new URL(specifier as string, baseUrl));
        },
        // Not implemented -> Cannot list directories for HTTP(s)
        listDir(_specifier: string) {
            return Promise.reject(new Error("http listDir not implemented"));
        },
        // Not implemented -> Cannot stat HTTP(s)
        stat(_specifier: string) {
            return Promise.reject(new Error("http stat not implemented"));
        }
    }
}

// Resolver for GitHub
export function createGithubResolver(baseUrl: URL, opts: { tokenEnv?: string, tokenValue?: string }): Resolver {
    const token = opts.tokenValue ?? (opts.tokenEnv ? Deno.env.get(opts.tokenEnv) : undefined);
    async function ghFetch(url: URL): Promise<Response> {
        const headers: HeadersInit = {
            Accept: "application/vnd.github+json",
            "User-Agent": "oxian-js/0.0.1",
        };
        if (token) headers["Authorization"] = `token ${token}`;
        const res = await fetch(url, { headers });
        return res;
    }

    return {
        scheme: "github",
        canHandle: (specifier: string) => specifier.startsWith("github:") || (specifier.startsWith("https:") && specifier.hostname === "github.com"),
        resolve(specifier?: string) {
            if ((specifier as unknown as URL)?.protocol === "https:") return Promise.resolve(specifier as unknown as URL);
            if (specifier?.startsWith("https:")) return Promise.resolve(new URL(specifier));
            const parsed = parseGithubUrl(specifier, baseUrl);
            if (!parsed) throw new Error(`Unsupported GitHub URL: ${url}`);
            const { owner, repo, ref, path } = parsed;
            const rawUrl = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
            return Promise.resolve(rawUrl)
        },
        async listDir(URLspecifier: URL) {
            const parsed = parseGithubUrl(URLspecifier, baseUrl);
            if (!parsed) return [];
            const { owner, repo, ref, path } = parsed;
            const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
            api.searchParams.set("ref", ref);
            const res = await ghFetch(api);
            if (res.status === 404) return [];
            if (!res.ok) throw new Error(`GitHub listDir failed ${res.status} for ${api}`);
            const json = await res.json() as Array<{ name: string; type: string }>;
            return Array.isArray(json) ? json.map((e) => e.name) : [];
        },
        async stat(URLspecifier: URL) {
            const parsed = parseGithubUrl(URLspecifier, baseUrl);
            if (!parsed) return { isFile: false };
            const { owner, repo, ref, path } = parsed;
            const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
            api.searchParams.set("ref", ref);
            const res = await ghFetch(api);
            if (res.status === 404) return { isFile: false };
            if (!res.ok) throw new Error(`GitHub stat failed ${res.status} for ${api}`);
            const json = await res.json() as { type?: string } | { message?: string };
            if ((json as { type?: string }).type === "file") {
                return { isFile: true };
            }
            return { isFile: false };
        },
    } as Resolver;
} 