import type {} from "@std/path";
import type {
  ListDirFn,
  RouteMatch,
  Router,
  RouteRecord,
  StatFn,
} from "./types.ts";
import {
  createRouteRecordFromRelativeFile,
  isRouteModuleFile,
} from "./route_segments.ts";

function compareSpecificity(a: RouteRecord, b: RouteRecord): number {
  const score = (r: RouteRecord) =>
    r.segments.reduce(
      (acc, s) => acc + (s.type === "static" ? 3 : s.type === "param" ? 2 : 1),
      0,
    );
  return score(b) - score(a);
}

function ensureTrailingSlash(u: URL): URL {
  const copy = new URL(u.toString());
  copy.pathname = copy.pathname.endsWith("/")
    ? copy.pathname
    : copy.pathname + "/";
  return copy;
}

function makeChildUrl(parent: URL, name: string): URL {
  const baseObj = ensureTrailingSlash(parent);
  return new URL(name, baseObj);
}

export async function buildEagerRouter(
  opts: { routesRootUrl: URL; listDir: ListDirFn; stat: StatFn },
): Promise<Router> {
  const { routesRootUrl, listDir, stat } = opts;

  async function walk(dirUrl: URL, prefix = ""): Promise<string[]> {
    const names = await listDir(dirUrl);
    const files: string[] = [];
    for (const name of names) {
      const child = makeChildUrl(dirUrl, name);
      try {
        const st = await stat(child);
        if (st.isFile) {
          if (name.startsWith("_") || !isRouteModuleFile(name)) continue;
          files.push(prefix + "/" + name);
        } else files.push(...(await walk(child, prefix + "/" + name)));
      } catch {
        // ignore
      }
    }
    return files;
  }

  const relFiles = await walk(routesRootUrl, "");
  const pipelineNames = new Set([
    "dependencies.ts",
    "middleware.ts",
    "interceptors.ts",
    "dependencies.js",
    "middleware.js",
    "interceptors.js",
  ]);
  const routes: RouteRecord[] = [];
  for (const rel of relFiles) {
    const base = rel.split("/").pop()!;
    if (pipelineNames.has(base)) continue;

    const baseObj = ensureTrailingSlash(routesRootUrl);
    const fileUrl = new URL(rel.startsWith("/") ? rel.slice(1) : rel, baseObj);
    const route = createRouteRecordFromRelativeFile(rel, fileUrl);
    if (!route) continue;
    routes.push(route);
  }

  routes.sort(compareSpecificity);

  function match(path: string): RouteMatch {
    const parts = path.split("/").filter(Boolean);
    for (const r of routes) {
      const params: Record<string, string | string[]> = {};
      let ok = true;
      let i = 0, j = 0;
      while (i < r.segments.length && j < parts.length) {
        const segment = r.segments[i];
        const p = parts[j];
        if (segment.type === "catchall") {
          params[segment.name] = parts.slice(j).map(decodeURIComponent);
          j = parts.length;
          i = r.segments.length;
          break;
        } else if (segment.type === "param") {
          params[segment.name] = decodeURIComponent(p);
          i++;
          j++;
        } else if (segment.value === p) {
          i++;
          j++;
        } else {
          ok = false;
          break;
        }
      }
      if (ok && i === r.segments.length && j === parts.length) {
        return { route: r, params };
      }
    }
    return null;
  }

  return { routes, match };
}
