export type RouteRecord = {
  pattern: string;
  segments: Array<{ type: "static" | "param" | "catchall"; name?: string }>;
  fileUrl: URL;
};

export type RouteMatch =
  | { route: RouteRecord; params: Record<string, string> }
  | null;

export type Router = {
  routes: RouteRecord[];
  match: (path: string) => RouteMatch;
};

type DirEntries = { files: Set<string>; dirs: Set<string> };

export type ListDirFn = (dir: URL) => Promise<string[]>;
export type StatFn = (url: URL) => Promise<{ isFile: boolean }>;

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

function toSegments(pattern: string): RouteRecord["segments"] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return { type: "catchall" } as const;
    if (seg.startsWith(":")) {
      return { type: "param", name: seg.slice(1) } as const;
    }
    return { type: "static" } as const;
  });
}

function findFileBaseMatch(files: Set<string>, base: string): string | null {
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of exts) {
    const name = base + ext;
    if (files.has(name)) return name;
  }
  return null;
}

export function createLazyRouter(
  opts: { routesRootUrl: URL; listDir: ListDirFn; stat: StatFn },
): Router & { __asyncMatch: (path: string) => Promise<RouteMatch> } {
  const { routesRootUrl, listDir, stat } = opts;

  async function matchPath(path: string): Promise<RouteMatch> {
    const parts = path.split("/").filter(Boolean);
    let curDir = routesRootUrl;
    const params: Record<string, string> = {};
    let consumed = 0;

    const rootEntries = await listEntries(curDir, listDir, stat);

    let catchAllUrl: URL | null = null;
    {
      const ca = findFileBaseMatch(rootEntries.files, "[...slug]");
      if (ca) catchAllUrl = makeChildUrl(curDir, ca);
    }

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const entries = await listEntries(curDir, listDir, stat);

      if (i === parts.length - 1) {
        const directName = findFileBaseMatch(entries.files, seg);
        if (directName) {
          const fileUrl = makeChildUrl(curDir, directName);
          return {
            route: {
              pattern: "/" + parts.join("/"),
              segments: toSegments("/" + parts.join("/")),
              fileUrl,
            },
            params,
          };
        }
        const paramName = [...entries.files].find((f) =>
          /^\[[^\.]+\]\.(tsx?|jsx?)$/.test(f)
        );
        if (paramName) {
          const name = paramName.match(/^\[(.+)\]\./)?.[1] ?? "param";
          params[name] = decodeURIComponent(seg);
          const pattern = "/" + [...parts.slice(0, -1), ":" + name].join("/");
          const fileUrl = makeChildUrl(curDir, paramName);
          return {
            route: { pattern, segments: toSegments(pattern), fileUrl },
            params,
          };
        }
      }

      if (entries.dirs.has(seg)) {
        curDir = makeChildUrl(curDir, seg + "/");
        const dirEntries = await listEntries(curDir, listDir, stat);
        const ca = findFileBaseMatch(dirEntries.files, "[...slug]");
        if (ca) catchAllUrl = makeChildUrl(curDir, ca);
        consumed++;
        continue;
      }

      const pdir = [...entries.dirs].find((d) => /^\[[^\.]+\]$/.test(d));
      if (pdir) {
        const name = pdir.slice(1, -1);
        params[name] = decodeURIComponent(seg);
        curDir = makeChildUrl(curDir, pdir + "/");
        const dirEntries = await listEntries(curDir, listDir, stat);
        const ca = findFileBaseMatch(dirEntries.files, "[...slug]");
        if (ca) catchAllUrl = makeChildUrl(curDir, ca);
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
      const pattern = "/" + rel.split("/").filter(Boolean).join("/") + "/";
      return {
        route: { pattern, segments: toSegments(pattern), fileUrl },
        params,
      };
    }

    if (catchAllUrl) {
      const basePath = ensureTrailingSlash(routesRootUrl).pathname;
      const curPath = ensureTrailingSlash(curDir).pathname;
      const rel = curPath.startsWith(basePath)
        ? curPath.slice(basePath.length)
        : curPath;
      const relParts = rel.split("/").filter(Boolean);
      const depth = relParts.length;
      params.slug = parts.slice(depth).join("/");
      const pattern = "/" + relParts.join("/") + "/*";
      return {
        route: { pattern, segments: toSegments(pattern), fileUrl: catchAllUrl },
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
