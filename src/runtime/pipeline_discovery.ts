import { dirname, join, fromFileUrl, toFileUrl } from "@std/path";
import type { Resolver } from "../resolvers/index.ts";

export type PipelineFiles = {
    dependencyFiles: URL[];
    middlewareFiles: URL[];
    interceptorFiles: URL[];
    sharedFiles: URL[];
};


export async function discoverPipelineFiles(
    chain: Array<string | URL>,
    resolver: Resolver,
    opts?: { allowShared?: boolean },
): Promise<PipelineFiles> {
    const now = performance.now();
    const files: PipelineFiles = { dependencyFiles: [], middlewareFiles: [], interceptorFiles: [], sharedFiles: [] };
    const DEBUG = Deno.env.get("OXIAN_DEBUG") === "1";
    if (DEBUG) {
        try {
            console.log('[pipeline] discover start', { levels: chain.map((l) => typeof l === 'string' ? l : l.toString()) });
        } catch (_e) { /* ignore log error */ }
    }
    for (const level of chain) {
        let depsts: string | URL;
        let depsjs: string | URL;
        let mwts: string | URL;
        let mwjs: string | URL;
        let icts: string | URL;
        let icjs: string | URL;

        let shjs: string | URL = "";
        let shts: string | URL = "";

        if (typeof level === "string") {
            depsjs = join(level, "dependencies.js");
            depsts = join(level, "dependencies.ts");

            mwts = join(level, "middleware.ts");
            mwjs = join(level, "middleware.js");

            icts = join(level, "interceptors.ts");
            icjs = join(level, "interceptors.js");
            if (opts?.allowShared) {
                shjs = join(level, "shared.js");
                shts = join(level, "shared.ts");
            }
        } else {
            if (level.protocol === "github:") {
                const basePath = level.pathname.endsWith("/") ? level.pathname : level.pathname + "/";
                const make = (name: string) => new URL(`github:${(basePath + name).replace(/^\/+/, "")}`);
                depsjs = make("dependencies.js");
                depsts = make("dependencies.ts");

                mwjs = make("middleware.js");
                mwts = make("middleware.ts");

                icjs = make("interceptors.js");
                icts = make("interceptors.ts");

                if (opts?.allowShared) {
                    shjs = make("shared.js");
                    shts = make("shared.ts");
                }
            } else {
                const baseObj = new URL(level.toString());
                baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
                depsjs = new URL("dependencies.js", baseObj);
                depsts = new URL("dependencies.ts", baseObj);

                mwjs = new URL("middleware.js", baseObj);
                mwts = new URL("middleware.ts", baseObj);

                icjs = new URL("interceptors.js", baseObj);
                icts = new URL("interceptors.ts", baseObj);

                if (opts?.allowShared) {
                    shjs = new URL("shared.js", baseObj);
                    shts = new URL("shared.ts", baseObj);
                }
            }
        }

        const exists = async (input: string | URL): Promise<boolean> => {
            // Prefer import-based existence check to leverage Deno cache; fallback to stat
            return await resolver.import(input.toString())
                .then(m => m.default ? true : false)
                .catch(() => false);
        };

        const depstsOk = await exists(depsts);
        const depsjsOk = await exists(depsjs);
        const mwtsOk = await exists(mwts);
        const mwjsOk = await exists(mwjs);
        const ictsOk = await exists(icts);
        const icjsOk = await exists(icjs);
        let shjsOk = false;
        let shtsOk = false;

        if (opts?.allowShared) {
            shjsOk = await exists(shjs);
            shtsOk = await exists(shts);
        }

        if (DEBUG) {
            try {
                console.log('[pipeline] probe', {
                    level: typeof level === 'string' ? level : level.toString(),
                    depsts: typeof depsts === 'string' ? depsts : depsts.toString(), depstsOk,
                    depsjs: typeof depsjs === 'string' ? depsjs : depsjs.toString(), depsjsOk,
                    mwts: typeof mwts === 'string' ? mwts : mwts.toString(), mwtsOk,
                    mwjs: typeof mwjs === 'string' ? mwjs : mwjs.toString(), mwjsOk,
                    icts: typeof icts === 'string' ? icts : icts.toString(), ictsOk,
                    icjs: typeof icjs === 'string' ? icjs : icjs.toString(), icjsOk,
                    shjs: typeof shjs === 'string' ? shjs : shjs.toString(), shjsOk,
                    shts: typeof shts === 'string' ? shts : shts.toString(), shtsOk,
                });
            } catch (_e) { /* ignore log error */ }
        }
        if (depstsOk) files.dependencyFiles.push(typeof depsts === "string" ? toFileUrl(depsts) : depsts);
        if (depsjsOk) files.dependencyFiles.push(typeof depsjs === "string" ? toFileUrl(depsjs) : depsjs);
        if (mwtsOk) files.middlewareFiles.push(typeof mwts === "string" ? toFileUrl(mwts) : mwts);
        if (mwjsOk) files.middlewareFiles.push(typeof mwjs === "string" ? toFileUrl(mwjs) : mwjs);
        if (ictsOk) files.interceptorFiles.push(typeof icts === "string" ? toFileUrl(icts) : icts);
        if (icjsOk) files.interceptorFiles.push(typeof icjs === "string" ? toFileUrl(icjs) : icjs);
        if (shjsOk) files.sharedFiles.push(typeof shjs === "string" ? toFileUrl(shjs) : shjs);
        if (shtsOk) files.sharedFiles.push(typeof shts === "string" ? toFileUrl(shts) : shts);
    }
    if (DEBUG) {
        console.log('[pipeline] discover end', { time: performance.now() - now });
    }
    return files;
}

export async function buildLocalChain(resolver: Resolver, routesDir: string, routeFileUrl: URL): Promise<string[]> {
    const routesRoot = fromFileUrl((await resolver.resolve(routesDir)).toString());
    const routeFilePath = fromFileUrl(routeFileUrl)
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

export async function buildRemoteChain(resolver: Resolver, routeFileUrl: URL): Promise<URL[]> {
    const routesRootUrl = await resolver.resolve(routeFileUrl);
    const basePath = routesRootUrl.pathname.split("/").filter(Boolean).join("/");
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
            const dirPath = `${rootPath}/${parts.slice(0, i + 1).join("/")}`;
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