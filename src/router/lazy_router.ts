import type {
  ListDirFn,
  RouteMatch,
  Router,
  RouteRecord,
  StatFn,
} from "./types.ts";
import {
  createRouteRecord,
  isCatchAllSegmentToken,
  isParamSegmentToken,
  isRouteModuleFile,
  parseRouteSegmentToken,
  stripRouteModuleExtension,
} from "./route_segments.ts";

type DirEntries = { files: Set<string>; dirs: Set<string> };

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

async function listEntries(
  dir: URL,
  listDir: ListDirFn,
  stat: StatFn,
): Promise<DirEntries> {
  const names = await listDir(dir);
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const name of names) {
    const child = makeChildUrl(dir, name);
    try {
      const st = await stat(child);
      if (st.isFile) files.add(name);
      else dirs.add(name);
    } catch {
      // If stat fails, ignore entry
    }
  }
  return { files, dirs };
}

function findFileMatch(
  files: Set<string>,
  predicate: (baseName: string) => boolean,
): string | null {
  for (const fileName of files) {
    if (!isRouteModuleFile(fileName)) continue;
    if (predicate(stripRouteModuleExtension(fileName))) return fileName;
  }
  return null;
}

function findFileBaseMatch(files: Set<string>, base: string): string | null {
  return findFileMatch(files, (baseName) => baseName === base);
}

function findCatchAllFile(files: Set<string>): string | null {
  return findFileMatch(files, isCatchAllSegmentToken);
}

function findParamFile(files: Set<string>): string | null {
  return findFileMatch(files, isParamSegmentToken);
}

export function createLazyRouter(
  opts: { routesRootUrl: URL; listDir: ListDirFn; stat: StatFn },
): Router & { __asyncMatch: (path: string) => Promise<RouteMatch> } {
  const { routesRootUrl, listDir, stat } = opts;

  async function matchPath(path: string): Promise<RouteMatch> {
    const parts = path.split("/").filter(Boolean);
    let curDir = routesRootUrl;
    const params: Record<string, string | string[]> = {};
    let consumed = 0;

    const rootEntries = await listEntries(curDir, listDir, stat);

    let catchAllFile: string | null = null;
    {
      const ca = findCatchAllFile(rootEntries.files);
      if (ca) catchAllFile = ca;
    }

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const entries = await listEntries(curDir, listDir, stat);

      if (i === parts.length - 1) {
        const directName = findFileBaseMatch(entries.files, seg);
        if (directName) {
          const fileUrl = makeChildUrl(curDir, directName);
          const basePath = ensureTrailingSlash(routesRootUrl).pathname;
          const curPath = ensureTrailingSlash(curDir).pathname;
          const rel = curPath.startsWith(basePath)
            ? curPath.slice(basePath.length)
            : curPath;
          const relParts = rel.split("/").filter(Boolean);
          return {
            route: createRouteRecord([...relParts, seg], fileUrl),
            params,
          };
        }
        const paramName = findParamFile(entries.files);
        if (paramName) {
          const parsed = parseRouteSegmentToken(
            stripRouteModuleExtension(paramName),
          );
          if (parsed.type !== "param") {
            throw new Error("Expected param route segment");
          }
          params[parsed.name] = decodeURIComponent(seg);
          const fileUrl = makeChildUrl(curDir, paramName);
          const basePath = ensureTrailingSlash(routesRootUrl).pathname;
          const curPath = ensureTrailingSlash(curDir).pathname;
          const rel = curPath.startsWith(basePath)
            ? curPath.slice(basePath.length)
            : curPath;
          const relParts = rel.split("/").filter(Boolean);
          return {
            route: createRouteRecord([
              ...relParts,
              stripRouteModuleExtension(paramName),
            ], fileUrl),
            params,
          };
        }
      }

      if (entries.dirs.has(seg)) {
        curDir = makeChildUrl(curDir, seg + "/");
        const dirEntries = await listEntries(curDir, listDir, stat);
        const ca = findCatchAllFile(dirEntries.files);
        if (ca) catchAllFile = ca;
        consumed++;
        continue;
      }

      const pdir = [...entries.dirs].find(isParamSegmentToken);
      if (pdir) {
        const parsed = parseRouteSegmentToken(pdir);
        if (parsed.type !== "param") {
          throw new Error("Expected param route segment");
        }
        params[parsed.name] = decodeURIComponent(seg);
        curDir = makeChildUrl(curDir, pdir + "/");
        const dirEntries = await listEntries(curDir, listDir, stat);
        const ca = findCatchAllFile(dirEntries.files);
        if (ca) catchAllFile = ca;
        consumed++;
        continue;
      }
      break;
    }

    const finalEntries = await listEntries(curDir, listDir, stat);
    const indexName = findFileBaseMatch(finalEntries.files, "index");
    // Only return directory index if we fully consumed the path
    if (indexName && consumed === parts.length) {
      const fileUrl = makeChildUrl(curDir, indexName);
      const basePath = ensureTrailingSlash(routesRootUrl).pathname;
      const curPath = ensureTrailingSlash(curDir).pathname;
      const rel = curPath.startsWith(basePath)
        ? curPath.slice(basePath.length)
        : curPath;
      return {
        route: createRouteRecord(rel.split("/").filter(Boolean), fileUrl, {
          trailingSlash: true,
        }),
        params,
      };
    }

    if (catchAllFile) {
      const basePath = ensureTrailingSlash(routesRootUrl).pathname;
      const curPath = ensureTrailingSlash(curDir).pathname;
      const rel = curPath.startsWith(basePath)
        ? curPath.slice(basePath.length)
        : curPath;
      const relParts = rel.split("/").filter(Boolean);
      const depth = relParts.length;
      const parsed = parseRouteSegmentToken(
        stripRouteModuleExtension(catchAllFile),
      );
      if (parsed.type !== "catchall") {
        throw new Error("Expected catch-all route segment");
      }
      params[parsed.name] = parts.slice(depth).map(decodeURIComponent);
      const fileUrl = makeChildUrl(curDir, catchAllFile);
      return {
        route: createRouteRecord([
          ...relParts,
          stripRouteModuleExtension(catchAllFile),
        ], fileUrl),
        params,
      };
    }

    return null;
  }

  return {
    routes: [],
    match: (_path: string) => null,
    __asyncMatch: matchPath,
  } as unknown as Router & {
    __asyncMatch: (path: string) => Promise<RouteMatch>;
  };
}
