import type { Loader } from "../loader/types.ts";
import { createCache } from "@deno/cache-dir";
import { createGraph } from "@deno/graph";
import { resolveLocalUrl } from "../loader/local.ts";
import { parse as parseJsonc } from "@std/jsonc/parse";

const cachedImportMapByRoot = new Map<string, { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } | null>();

async function getProjectImportMap(loaders: Loader[], projectRoot?: string): Promise<{ imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } | undefined> {
    const root = projectRoot ?? Deno.cwd();
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

export async function importModule(url: URL, loaders: Loader[], _ttlMs = 60_000, projectRoot?: string): Promise<Record<string, unknown>> {
    const rootSpecifier = url.toString();
    const cache = createCache({ allowRemote: true, cacheSetting: "use" });
    const importMap = await getProjectImportMap(loaders, projectRoot);

    // first try our custom loaders; fall back to deno cache
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
        importMap,
    } as unknown as Record<string, unknown>);

    // With the graph constructed, do a regular import of the root. Deno will resolve from cache.
    return await import(rootSpecifier);
} 