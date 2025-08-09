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
    const names = await (loader.listDir?.(dirUrl) ?? Promise.resolve([]));
    const files: string[] = [];
    for (const name of names) {
      const child = new URL(name, dirUrl.toString().endsWith("/") ? dirUrl : new URL(dirUrl.toString() + "/"));
      const st = await (loader.stat?.(child) ?? Promise.resolve({ isFile: true }));
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
    routes.push({ pattern, segments: toSegments(pattern), fileUrl: new URL(rel, routesRootUrl) });
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