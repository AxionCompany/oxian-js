import type { Loader } from "../loader/types.ts";
import { bundle } from "@deno/emit";
import { resolveLocalUrl } from "../loader/local.ts";
import { parse as parseJsonc } from "@std/jsonc/parse";

const bundleCache = new Map<string, { code: string; expiresAt: number }>();
const cachedImportMapByRoot = new Map<string, { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } | null>();
let defaultProjectRoot: string | undefined;

export function setBundlerProjectRoot(root: string) {
    defaultProjectRoot = root;
}

async function getProjectImportMap(loaders: Loader[], projectRoot?: string): Promise<{ imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } | undefined> {
    const root = projectRoot ?? defaultProjectRoot ?? Deno.cwd();
    if (cachedImportMapByRoot.has(root)) return cachedImportMapByRoot.get(root) ?? undefined;

    const candidates = ["deno.json", "deno.jsonc"];
    for (const name of candidates) {
        try {
            const url = resolveLocalUrl(root, name);
            const ldr = loaders.find((l) => l.canHandle(url));
            if (!ldr) continue;
            const { content } = await ldr.load(url);
            const isJsonc = name.endsWith(".jsonc");
            const parsed = isJsonc ? (parseJsonc(content) as Record<string, unknown>) : (JSON.parse(content) as Record<string, unknown>);
            const imports = (parsed["imports"] ?? undefined) as Record<string, string> | undefined;
            const scopes = (parsed["scopes"] ?? undefined) as Record<string, Record<string, string>> | undefined;
            const map = { imports, scopes };
            cachedImportMapByRoot.set(root, map);
            return map;
        } catch {
            // try next candidate
        }
    }
    cachedImportMapByRoot.set(root, null);
    return undefined;
}

export async function bundleModule(entry: URL, loaders: Loader[], ttlMs = 60_000, projectRoot?: string): Promise<string> {
    const loader = loaders.find((l) => l.canHandle(entry));
    if (!loader) throw new Error(`No loader for ${entry}`);
    const cacheKey = (loader.cacheKey?.(entry) ?? entry.toString()) + `|ttl=${ttlMs}`;
    const now = Date.now();
    const cached = bundleCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
        return cached.code;
    }

    const importMap = await getProjectImportMap(loaders, projectRoot);

    try {
        const result = await bundle(entry.toString(), {
            load: async (specifier: string) => {

                try {
                    const url = new URL(specifier);
                    const ldr = loaders.find((l) => l.canHandle(url));
                    if (!ldr) {
                        return undefined as unknown as { kind: "module"; specifier: string; content: string };
                    }
                    const { content } = await ldr.load(url);
                    return { kind: "module", specifier: url.toString(), content } as { kind: "module"; specifier: string; content: string };
                } catch {
                    return undefined as unknown as { kind: "module"; specifier: string; content: string };
                }
            },
            cacheSetting: "use",
            allowRemote: true,
            compilerOptions: {
                inlineSourceMap: true,
                inlineSources: true,
            },
            type: "module",
            importMap
        } as unknown as Record<string, unknown>);

        const code = (result as unknown as { code?: string }).code;
        if (code && code.length > 0) {
            bundleCache.set(cacheKey, { code, expiresAt: now + ttlMs });
            return code;
        }
    } catch (_e) {
        console.log("ERROR BUNDLING", entry.toString(), _e);
        // fall through to direct-load fallback below
    }

    const { content } = await loader.load(entry);
    bundleCache.set(cacheKey, { code: content, expiresAt: now + ttlMs });
    return content;
} 