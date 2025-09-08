import type { Loader } from "../loader/types.ts";

export type RemoteRouteRecord = {
  pattern: string;
  segments: Array<{ type: "static" | "param" | "catchall"; name?: string }>;
  fileUrl: URL;
};

export type RemoteRouter = {
  routes: RemoteRouteRecord[];
  match: (path: string) => { route: RemoteRouteRecord; params: Record<string, string> } | null;
};

function toSegments(pattern: string): RemoteRouteRecord["segments"] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return { type: "catchall" } as const;
    if (seg.startsWith(":")) return { type: "param", name: seg.slice(1) } as const;
    return { type: "static" } as const;
  });
}

function compareSpecificity(a: RemoteRouteRecord, b: RemoteRouteRecord): number {
  const score = (r: RemoteRouteRecord) => r.segments.reduce((acc, s) => acc + (s.type === "static" ? 3 : s.type === "param" ? 2 : 1), 0);
  return score(b) - score(a);
}

function fileToPattern(relPath: string): string | null {
  if (!/\.(tsx?|jsx?)$/.test(relPath)) return null;
  let path = relPath.replace(/\.(tsx?|jsx?)$/, "");
  path = path.replace(/\/index$/, "/");
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\[(\.\.\.)?([\w-]+)\]/g, (_m, dots, name) => {
    if (dots) return `*`;
    return `:${name}`;
  });
  return path === "" ? "/" : path;
}

export async function buildRemoteRouter(loader: Loader, routesRootUrl: URL): Promise<RemoteRouter> {
  async function walk(dirUrl: URL, prefix = ""): Promise<string[]> {
    const DEBUG = Deno.env.get("OXIAN_DEBUG") === "1";
    const names = await (loader.listDir?.(dirUrl) ?? Promise.resolve([]));
    if (DEBUG) {
      try { console.log('[remote_router] listDir', { dir: dirUrl.toString(), names }); } catch (_e) { /* ignore log error */ }
    }
    const files: string[] = [];
    for (const name of names) {
      let child: URL;
      if (dirUrl.protocol === "github:") {
        const basePath = dirUrl.pathname;
        const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${name}`;
        const abs = `github:${joinedPath.replace(/^\//, "")}${dirUrl.search}`;
        child = new URL(abs);
      } else {
        // Ensure trailing slash on pathname without touching search/hash
        const baseObj = new URL(dirUrl.toString());
        baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
        child = new URL(name, baseObj);
      }
      const st = await (loader.stat?.(child) ?? Promise.resolve({ isFile: true }));
      if (DEBUG) {
        try { console.log('[remote_router] stat', { child: child.toString(), st }); } catch (_e) { /* ignore log error */ }
      }
      if (st.isFile) files.push(prefix + "/" + name);
      else files.push(...(await walk(child, prefix + "/" + name)));
    }
    return files;
  }

  const relFiles = await walk(routesRootUrl, "");
  const pipelineNames = new Set(["dependencies.ts", "middleware.ts", "interceptors.ts"]);
  const routes: RemoteRouteRecord[] = [];
  for (const rel of relFiles) {
    const base = rel.split("/").pop()!;
    if (pipelineNames.has(base)) continue;
    const pattern = fileToPattern(rel);
    if (!pattern) continue;
    let fileUrl: URL;
    if (routesRootUrl.protocol === "github:") {
      const rootPath = routesRootUrl.pathname.replace(/\/?$/, "/");
      const relPath = rel.startsWith("/") ? rel.slice(1) : rel;
      const abs = `github:${(rootPath + relPath).replace(/^\//, "")}${routesRootUrl.search}`;
      fileUrl = new URL(abs);
    } else {
      const baseObj = new URL(routesRootUrl.toString());
      baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
      fileUrl = new URL(rel.startsWith("/") ? rel.slice(1) : rel, baseObj);
    }
    if (Deno.env.get("OXIAN_DEBUG") === "1") {
      try { console.log('[remote_router] route', { rel, pattern, file: fileUrl.toString() }); } catch (_e) { /* ignore log error */ }
    }
    routes.push({ pattern, segments: toSegments(pattern), fileUrl });
  }
  routes.sort(compareSpecificity);

  function match(path: string) {
    const parts = path.split("/").filter(Boolean);
    for (const r of routes) {
      const params: Record<string, string> = {};
      const rparts = r.pattern.split("/").filter(Boolean);
      let ok = true;
      let i = 0, j = 0;
      while (i < rparts.length && j < parts.length) {
        const rp = rparts[i];
        const p = parts[j];
        if (rp === "*") {
          params["slug"] = parts.slice(j).join("/");
          j = parts.length;
          i = rparts.length;
          break;
        } else if (rp.startsWith(":")) {
          params[rp.slice(1)] = decodeURIComponent(p);
          i++; j++;
        } else if (rp === p) {
          i++; j++;
        } else {
          ok = false; break;
        }
      }
      if (ok && i === rparts.length && j === parts.length) return { route: r, params };
    }
    return null;
  }

  return { routes, match };
} 