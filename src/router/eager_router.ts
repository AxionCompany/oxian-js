import type {} from "@std/path";
import type { RouteRecord, RouteMatch, Router, ListDirFn, StatFn } from "./types.ts";

function toSegments(pattern: string): RouteRecord["segments"] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return { type: "catchall" } as const;
    if (seg.startsWith(":")) {
      return { type: "param", name: seg.slice(1) } as const;
    }
    return { type: "static" } as const;
  });
}

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
          if (name.startsWith("_")) continue;
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
    const pattern = fileToPattern(rel);
    if (!pattern) continue;

    const baseObj = ensureTrailingSlash(routesRootUrl);
    const fileUrl = new URL(rel.startsWith("/") ? rel.slice(1) : rel, baseObj);
    routes.push({ pattern, segments: toSegments(pattern), fileUrl });
  }

  routes.sort(compareSpecificity);

  function match(path: string): RouteMatch {
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
          i++;
          j++;
        } else if (rp === p) {
          i++;
          j++;
        } else {
          ok = false;
          break;
        }
      }
      if (ok && i === rparts.length && j === parts.length) {
        return { route: r, params };
      }
    }
    return null;
  }

  return { routes, match };
}
