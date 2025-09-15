import { isAbsolute, toFileUrl, join } from "@std/path";
import { importModule } from "./importer.ts";

const inMemoryCache = new Map<string, unknown>();

export function parseGithubUrl(specifier: string | URL, baseUrl: URL): { owner: string; repo: string; ref: string; path: string } | null {
    // Prioritize specifier full URL if it's raw.githubusercontent.com over github.com
    try {
        const specUrl = specifier instanceof URL
            ? specifier
            : ((typeof specifier === "string" && (specifier.startsWith("http:") || specifier.startsWith("https:")))
                ? new URL(specifier)
                : undefined);
        if (specUrl?.protocol === "https:" && specUrl.hostname === "raw.githubusercontent.com") {
            const input = specUrl;
            const parts = input.pathname.split("/").filter(Boolean);
            const [owner, repo, _1, _2, ref, ...path] = parts;
            if (!owner || !repo || !ref || !path.length) return null;
            return { owner, repo, ref, path: path.join("/") };
        }
    } catch { /* ignore */ }

    // Parse github: base URLs
    if (baseUrl.protocol === "github:") {
        const specStr = specifier instanceof URL ? specifier.toString() : String(specifier ?? "");
        const input = new URL(`https://github.com/${baseUrl.pathname}/${specStr}?${baseUrl.searchParams.toString()}`);
        const [owner, repo, ...rest] = input.pathname.split("/").filter(Boolean);
        const path = rest.join("/");
        const ref = input.searchParams.get("ref") ?? "main";
        return owner && repo ? { owner, repo, ref, path } : null;
    }
    // Parse github.com base URLs
    if (baseUrl.protocol === "https:" && baseUrl.hostname === "github.com") {
        const input = new URL(specifier instanceof URL ? specifier.toString() : String(specifier ?? ""), baseUrl);
        const parts = input.pathname.split("/").filter(Boolean);
        const [owner, repo, _type, ref, ...rest] = parts;
        if (!owner || !repo) return null;
        const path = rest.join("/");
        const effectiveRef = ref ?? input.searchParams.get("ref") ?? "main";
        return { owner, repo, ref: effectiveRef, path };
    }
    // Parse raw.githubusercontent.com base URLs
    if (baseUrl.protocol === "https:" && baseUrl.hostname === "raw.githubusercontent.com") {
        const input = new URL(specifier instanceof URL ? specifier.toString() : String(specifier ?? ""), baseUrl);
        const parts = input.pathname.split("/").filter(Boolean);
        const [owner, repo, _1, _2, ref, ...pathParts] = parts;
        const path = pathParts.join("/");
        if (!owner || !repo || !ref || !path) return null;
        return { owner, repo, ref, path };
    }
    // Return null if no match
    return null;
}

export interface Resolver {
    scheme: "local" | "http" | "github";
    canHandle: (input: string | URL) => boolean;
    listDir: (dir: URL) => Promise<string[]>;
    stat: (url: URL) => Promise<{ isFile: boolean }>;
    resolve: (specifier: string | URL) => Promise<URL>;
    import: (specifier: string | URL) => Promise<Record<string, unknown>>;
    load: (url: URL) => Promise<string>;
}

// Main entry point for creating a resolver
export function createResolver(baseUrl: URL | string | undefined, opts: { tokenEnv?: string, tokenValue?: string, ttlMs?: number }): Resolver {
    let type: "local" | "http" | "github" = "local";

    try {
        if (baseUrl && !(baseUrl instanceof URL)) {
            baseUrl = new URL(baseUrl);
        }
    } catch { /* ignore */ }

    if (baseUrl instanceof URL && baseUrl.protocol) {
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
    } else { type = "local" }

    const resolverMap = {
        local: createLocalResolver(baseUrl as URL),
        http: createHttpResolver(baseUrl as URL),
        github: createGithubResolver(baseUrl as URL, { tokenEnv: opts.tokenEnv, tokenValue: opts.tokenValue }),
    };

    const baseKey = baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl ?? Deno.cwd());
    const cacheKey = (op: string, spec: string | URL) => `${op}::${baseKey}::${spec?.toString()}`;

    const resolver: Resolver = {
        scheme: type,
        canHandle: (input: string | URL) => {
            try {
                const u = input instanceof URL ? input : new URL(String(input));
                if (type === "local") return u.protocol === "file:";
                if (type === "http") return u.protocol === "http:" || u.protocol === "https:";
                if (type === "github") return u.protocol === "github:" || u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com";
                return false;
            } catch { return typeof input === "string"; }
        },
        resolve: async (specifier: string | URL) => {
            const key = cacheKey("resolve", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as URL;
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}, ${specifier?.toString()}, ${baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl)}`);
            const url = await resolverMap[type].resolve(specifier as string | URL);
            inMemoryCache.set(key, url);
            return url;
        },
        listDir: async (specifier: URL) => {
            const key = cacheKey("listDir", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as string[];
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}, ${specifier?.toString()}, ${baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl)}`);
            const listDir = await resolverMap[type].listDir(await resolver.resolve(specifier));
            const array = Array.isArray(listDir) ? listDir : Array.from(listDir as unknown as Iterable<string>);
            inMemoryCache.set(key, array);
            return array;
        },
        stat: async (specifier: URL) => {
            const key = cacheKey("stat", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as { isFile: boolean };
            if (!resolverMap[type]) throw new Error(`Resolver not found for type: ${type}`);
            const stat = await resolverMap[type].stat(await resolver.resolve(specifier));
            inMemoryCache.set(key, stat);
            return stat;
        },
        import: async (specifier: string | URL) => {
            const key = cacheKey("import", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as Record<string, unknown>;
            const mod = await importModule(await resolver.resolve(specifier), opts.ttlMs);
            inMemoryCache.set(key, mod);
            return mod;
        },
        load: async (specifier: URL) => {
            const key = cacheKey("load", specifier);
            if (inMemoryCache.has(key)) return inMemoryCache.get(key) as string;
            const content = await resolverMap[type].load(specifier);
            inMemoryCache.set(key, content);
            return content;
        }
    };
    return resolver;
}

// Resolver for local files
export function createLocalResolver(baseUrl?: URL): Resolver {
    return {
        scheme: "local",
        canHandle: (input: string | URL) => {
            try {
                const u = input instanceof URL ? input : new URL(String(input));
                return u.protocol === "file:";
            } catch { return typeof input === "string"; }
        },
        resolve(specifier?: string | URL) {
            if (typeof specifier === "string" && specifier.startsWith("file:")) return Promise.resolve(new URL(specifier));
            if (specifier instanceof URL && specifier.protocol === "file:") return Promise.resolve(specifier);
            const url = isAbsolute(String(specifier))
                ? toFileUrl(String(specifier))
                : toFileUrl(join(baseUrl?.toString() ?? Deno.cwd(), String(specifier)));
            return Promise.resolve(url);
        },
        listDir(URLspecifier: URL) {
            const path = URLspecifier.toString().replace("file://", "");
            const entries = Array.from(Deno.readDirSync(path));
            return Promise.resolve(entries.map((entry) => entry.name));
        },
        stat(URLspecifier: URL) {
            const info = Deno.statSync(URLspecifier.toString().replace("file://", ""));
            return Promise.resolve({ isFile: info.isFile });
        },
        load(URLspecifier: URL) {
            return Promise.resolve(Deno.readTextFile(URLspecifier.toString().replace("file://", "")));
        }
    } as Resolver;
}

// Resolver for HTTP(s)
export function createHttpResolver(baseUrl: URL): Resolver {
    return {
        scheme: "http",
        canHandle: (input: string | URL) => {
            try {
                const u = input instanceof URL ? input : new URL(String(input));
                return u.protocol === "http:" || u.protocol === "https:";
            } catch { return typeof input === "string"; }
        },
        resolve(specifier?: string | URL) {
            if (typeof specifier === "string" && (specifier.startsWith("http:") || specifier.startsWith("https:"))) return Promise.resolve(new URL(specifier));
            if (specifier instanceof URL && (specifier.protocol === "http:" || specifier.protocol === "https:")) return Promise.resolve(specifier);
            return Promise.resolve(new URL(String(specifier), baseUrl));
        },
        // Not implemented -> Cannot list directories for HTTP(s)
        listDir(_specifier: URL) {
            return Promise.reject(new Error("http listDir not implemented"));
        },
        // Not implemented -> Cannot stat HTTP(s)
        stat(_specifier: URL) {
            return Promise.reject(new Error("http stat not implemented"));
        },
        load: async (specifier: URL) => {
            return fetch(specifier).then(res => res.text());
        }
    } as Resolver;
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
        canHandle: (input: string | URL) => {
            try {
                const u = input instanceof URL ? input : new URL(String(input));
                return u.protocol === "github:" || u.hostname === "github.com" || u.hostname === "raw.githubusercontent.com";
            } catch { return typeof input === "string"; }
        },
        resolve(specifier?: string | URL) {
            if (specifier instanceof URL && (specifier.protocol === "http:" || specifier.protocol === "https:")) return Promise.resolve(specifier);
            if (typeof specifier === "string" && (specifier.startsWith("http:") || specifier.startsWith("https:"))) return Promise.resolve(new URL(specifier));
            const parsed = parseGithubUrl(specifier ?? "", baseUrl);
            if (!parsed) throw new Error(`Unsupported GitHub URL: ${String(specifier)}`);
            const { owner, repo, ref, path } = parsed;
            const rawUrl = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${path}`);
            return Promise.resolve(rawUrl);
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
        load: async (URLspecifier: URL) => {
            let apiUrl = URLspecifier;
            if (URLspecifier.protocol === 'https:' && URLspecifier.hostname === 'raw.githubusercontent.com') {
                const [owner, repo, _1, _2, ref, ...path] = URLspecifier.pathname.split('/').filter(Boolean);
                apiUrl = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path.join('/')}`);
                apiUrl.searchParams.set("ref", ref);
            }
            const res = await ghFetch(apiUrl);
            if (!res.ok) throw new Error(`GitHub load failed ${res.status} for ${apiUrl}`);
            const resJson = await res.json();
            const content = resJson.content;
            const decoded = atob(content);
            return decoded;
        }
    } as Resolver;
} 