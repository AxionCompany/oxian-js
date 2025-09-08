import { dirname, join, fromFileUrl, toFileUrl } from "@std/path";
import type { Loader } from "../loader/types.ts";
import { importModule } from "./importer.ts";

export type PipelineFiles = {
    dependencyFiles: URL[];
    middlewareFiles: URL[];
    interceptorFiles: URL[];
};

export async function discoverPipelineFiles(
    chain: Array<string | URL>,
    opts?: { loaders?: Loader[]; projectRoot?: string },
): Promise<PipelineFiles> {
    const now = performance.now();
    const files: PipelineFiles = { dependencyFiles: [], middlewareFiles: [], interceptorFiles: [] };
    const DEBUG = Deno.env.get("OXIAN_DEBUG") === "1";
    if (DEBUG) {
        try {
            console.log('[pipeline] discover start', { levels: chain.map((l) => typeof l === 'string' ? l : l.toString()) });
        } catch (_e) { /* ignore log error */ }
    }
    for (const level of chain) {
        let deps: string | URL;
        let mw: string | URL;
        let ic: string | URL;
        if (typeof level === "string") {
            deps = join(level, "dependencies.ts");
            mw = join(level, "middleware.ts");
            ic = join(level, "interceptors.ts");
        } else {
            if (level.protocol === "github:") {
                const basePath = level.pathname.endsWith("/") ? level.pathname : level.pathname + "/";
                const search = level.search || "";
                const make = (name: string) => new URL(`github:${(basePath + name).replace(/^\/+/, "")}${search}`);
                deps = make("dependencies.ts");
                mw = make("middleware.ts");
                ic = make("interceptors.ts");
            } else {
                const baseObj = new URL(level.toString());
                baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
                deps = new URL("dependencies.ts", baseObj);
                mw = new URL("middleware.ts", baseObj);
                ic = new URL("interceptors.ts", baseObj);
            }
        }

        const exists = async (input: string | URL): Promise<boolean> => {
            // Prefer import-based existence check to leverage Deno cache; fallback to stat
            if (opts?.loaders) {
                try {
                    const u = typeof input === 'string' ? toFileUrl(input) : input;
                    // Only attempt import for URL-like inputs
                    if (typeof input !== 'string') {
                        return await importModule(u, opts.loaders, 60_000, opts.projectRoot).then(m => m.default ? true : false)
                    }
                } catch {
                    // fall through to stat
                }
            }
            return await importModule(input.toString(), opts?.loaders ?? [], 60_000, opts?.projectRoot)
                .then(m => m.default ? true : false)
                .catch(() => false);
        };

        const depsOk = await exists(deps);
        const mwOk = await exists(mw);
        const icOk = await exists(ic);
        if (DEBUG) {
            try {
                console.log('[pipeline] probe', {
                    level: typeof level === 'string' ? level : level.toString(),
                    deps: typeof deps === 'string' ? deps : deps.toString(), depsOk,
                    mw: typeof mw === 'string' ? mw : mw.toString(), mwOk,
                    ic: typeof ic === 'string' ? ic : ic.toString(), icOk,
                });
            } catch (_e) { /* ignore log error */ }
        }
        if (depsOk) files.dependencyFiles.push(typeof deps === "string" ? toFileUrl(deps) : deps);
        if (mwOk) files.middlewareFiles.push(typeof mw === "string" ? toFileUrl(mw) : mw);
        if (icOk) files.interceptorFiles.push(typeof ic === "string" ? toFileUrl(ic) : ic);
    }
    if (DEBUG) {
        console.log('[pipeline] discover end', { time: performance.now() - now });
    }
    return files;
}

export function buildLocalChain(root: string, routesDir: string, routeFileUrl: URL): string[] {
    const routesRoot = join(root, routesDir);
    const routeFilePath = fromFileUrl(routeFileUrl);
    let curDir = dirname(routeFilePath);
    const chain: string[] = [];
    while (curDir.startsWith(routesRoot)) {
        chain.push(curDir);
        const parent = dirname(curDir);
        if (parent === curDir) break;
        curDir = parent;
    }
    chain.reverse();
    return chain;
}

export function buildRemoteChain(routesRootUrl: URL, routeFileUrl: URL): URL[] {
    const basePath = routesRootUrl.pathname.endsWith("/") ? routesRootUrl.pathname : routesRootUrl.pathname + "/";
    if (!routeFileUrl.pathname.startsWith(basePath)) return [];
    const rel = routeFileUrl.pathname.slice(basePath.length);
    const parts = rel.split("/").filter(Boolean);
    const chain: URL[] = [];
    if (routesRootUrl.protocol === "github:") {
        const search = routesRootUrl.search || "";
        const rootPath = basePath;
        // include routes root first
        const rootAbs = `github:${rootPath.replace(/^\//, "")}${search}`;
        chain.push(new URL(rootAbs));
        // then each subdirectory up to the route's parent
        for (let i = 0; i < parts.length - 1; i++) {
            const dirPath = (rootPath + parts.slice(0, i + 1).join("/") + "/").replace(/^\//, "");
            const abs = `github:${dirPath}${search}`;
            chain.push(new URL(abs));
        }
        return chain;
    }
    // Fallback for http(s)/file: ensure trailing slash and use standard URL resolution
    let current = new URL(routesRootUrl.toString().endsWith("/") ? routesRootUrl : new URL(routesRootUrl.toString() + "/"));
    // include routes root first
    chain.push(new URL(current.toString()));
    for (let i = 0; i < parts.length - 1; i++) {
        const baseObj = new URL(current.toString());
        baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
        current = new URL(parts[i] + "/", baseObj);
        chain.push(new URL(current.toString()));
    }
    return chain;
} 