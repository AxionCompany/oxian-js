import { join, toFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";

export type RouteRecord = {
  pattern: string; // e.g., /users/:id
  segments: Array<{ type: "static" | "param" | "catchall"; name?: string }>;
  fileUrl: URL;
};

export type RouteMatch = { route: RouteRecord; params: Record<string, string> } | null;

export type Router = {
  routes: RouteRecord[];
  match: (path: string) => RouteMatch;
};

function parseRoutePathFromFile(rootRoutesDir: string, absFilePath: string): string | null {
  const rel = absFilePath.substring(rootRoutesDir.length).replaceAll("\\", "/");
  if (!rel.endsWith(".ts") && !rel.endsWith(".js") && !rel.endsWith(".tsx") && !rel.endsWith(".jsx")) return null;
  const noExt = rel.replace(/\.(tsx?|jsx?)$/, "");
  let path = noExt;
  path = path.replace(/\/index$/, "/");
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\[(\.\.\.)?([\w-]+)\]/g, (_m, dots, name) => {
    if (dots) return `*`;
    return `:${name}`;
  });
  return path === "" ? "/" : path;
}

function toSegments(pattern: string): RouteRecord["segments"] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return { type: "catchall" } as const;
    if (seg.startsWith(":")) return { type: "param", name: seg.slice(1) } as const;
    return { type: "static" } as const;
  });
}

function compareSpecificity(a: RouteRecord, b: RouteRecord): number {
  const score = (r: RouteRecord) => r.segments.reduce((acc, s) => acc + (s.type === "static" ? 3 : s.type === "param" ? 2 : 1), 0);
  return score(b) - score(a);
}

async function discoverFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      results.push(...(await discoverFiles(full)));
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

export async function buildRouter(opts: { root: string; routesDir?: string }): Promise<Router> {
  const routesRoot = join(opts.root, opts.routesDir ?? "routes");
  const files = (await discoverFiles(routesRoot)).filter((f) => /\/(index|\[|[^_].*)\.(tsx?|jsx?)$/.test(f));
  const pipelineNames = new Set(["dependencies.ts", "middleware.ts", "interceptors.ts"]);
  const routeRecords: RouteRecord[] = [];
  for (const file of files) {
    const base = file.split("/").pop()!;
    if (pipelineNames.has(base)) continue;
    const pattern = parseRoutePathFromFile(routesRoot, file);
    if (!pattern) continue;
    routeRecords.push({ pattern, segments: toSegments(pattern), fileUrl: toFileUrl(file) });
  }
  routeRecords.sort(compareSpecificity);

  function match(path: string): RouteMatch {
    const parts = path.split("/").filter(Boolean);
    for (const r of routeRecords) {
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
      if (ok && i === rparts.length && j === parts.length) {
        return { route: r, params };
      }
    }
    return null;
  }

  return { routes: routeRecords, match };
} 