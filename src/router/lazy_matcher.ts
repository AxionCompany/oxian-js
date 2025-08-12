import { join } from "@std/path";
import type { Router, RouteMatch, RouteRecord } from "./router.ts";
import type { Loader } from "../loader/types.ts";

const exts = [".ts", ".tsx", ".js", ".jsx"];

type DirEntries = { files: Set<string>; dirs: Set<string> };

async function listLocal(dir: string): Promise<DirEntries> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) dirs.add(entry.name);
    else files.add(entry.name);
  }
  return { files, dirs };
}

async function listRemote(dir: URL, loader: Loader): Promise<DirEntries> {
  const names = await (loader.listDir?.(dir) ?? Promise.resolve([]));
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const name of names) {
    const child = new URL(name, dir.toString().endsWith("/") ? dir : new URL(dir.toString() + "/"));
    const st = await (loader.stat?.(child) ?? Promise.resolve({ isFile: true }));
    if (st.isFile) files.add(name);
    else dirs.add(name);
  }
  return { files, dirs };
}

function findFileBaseMatch(files: Set<string>, base: string): string | null {
  for (const ext of exts) {
    const name = base + ext;
    if (files.has(name)) return name;
  }
  return null;
}

function toSegments(pattern: string): RouteRecord["segments"] {
  return pattern.split("/").filter(Boolean).map((seg) => {
    if (seg === "*") return { type: "catchall" } as const;
    if (seg.startsWith(":")) return { type: "param", name: seg.slice(1) } as const;
    return { type: "static" } as const;
  });
}

export function createLazyRouterLocal(root: string, routesDir: string): Router & { __asyncMatch: (path: string) => Promise<RouteMatch> } {
  const rootDir = join(root, routesDir);
  const dirCache = new Map<string, DirEntries>();

  async function getDir(dir: string): Promise<DirEntries> {
    const cached = dirCache.get(dir);
    if (cached) return cached;
    const listed = await listLocal(dir);
    dirCache.set(dir, listed);
    return listed;
  }

  async function matchPath(path: string): Promise<RouteMatch> {
    const parts = path.split("/").filter(Boolean);
    let curDir = rootDir;
    const params: Record<string, string> = {};
    const patternParts: string[] = [];

    const rootEntries = await getDir(curDir);
    const catchAll = findFileBaseMatch(rootEntries.files, "[...slug]");
    let catchAllFile: string | null = catchAll ? join(curDir, catchAll) : null;

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const entries = await getDir(curDir);

      if (i === parts.length - 1) {
        const directFile = findFileBaseMatch(entries.files, seg);
        if (directFile) {
          patternParts.push(seg);
          return {
            route: {
              pattern: "/" + patternParts.join("/"),
              segments: toSegments("/" + patternParts.join("/")),
              fileUrl: new URL("file://" + join(curDir, directFile)),
            },
            params,
          };
        }
        const paramFile = [...entries.files].find((f) => /^\[[^\.]+\]\.(tsx?|jsx?)$/.test(f));
        if (paramFile) {
          const name = paramFile.match(/^\[(.+)\]\./)?.[1] ?? "param";
          params[name] = decodeURIComponent(seg);
          patternParts.push(":" + name);
          return {
            route: { pattern: "/" + patternParts.join("/"), segments: toSegments("/" + patternParts.join("/")), fileUrl: new URL("file://" + join(curDir, paramFile)) },
            params,
          };
        }
      }

      if ((await entries).dirs.has(seg)) {
        curDir = join(curDir, seg);
        patternParts.push(seg);
        const dirEntries = await getDir(curDir);
        const ca = findFileBaseMatch(dirEntries.files, "[...slug]");
        if (ca) catchAllFile = join(curDir, ca);
        continue;
      }

      const paramDir = [...entries.dirs].find((d) => /^\[[^\.]+\]$/.test(d));
      if (paramDir) {
        const name = paramDir.slice(1, -1);
        params[name] = decodeURIComponent(seg);
        curDir = join(curDir, paramDir);
        patternParts.push(":" + name);
        const dirEntries = await getDir(curDir);
        const ca = findFileBaseMatch(dirEntries.files, "[...slug]");
        if (ca) catchAllFile = join(curDir, ca);
        continue;
      }

      break;
    }

    const finalEntries = await getDir(curDir);
    const indexFile = findFileBaseMatch(finalEntries.files, "index");
    if (indexFile) {
      return {
        route: {
          pattern: "/" + (patternParts.join("/") || ""),
          segments: toSegments("/" + (patternParts.join("/") || "")),
          fileUrl: new URL("file://" + join(curDir, indexFile)),
        },
        params,
      };
    }

    if (catchAllFile) {
      params["slug"] = parts.join("/");
      return {
        route: { pattern: "/*", segments: toSegments("/*"), fileUrl: new URL("file://" + catchAllFile) },
        params,
      };
    }

    return null;
  }

  return {
    routes: [],
    match: (_path: string) => null,
    __asyncMatch: matchPath,
  } as unknown as Router & { __asyncMatch: (path: string) => Promise<RouteMatch> };
}

export function createLazyRouterRemote(loader: Loader, routesRootUrl: URL): Router & { __asyncMatch: (path: string) => Promise<RouteMatch> } {
  const dirCache = new Map<string, DirEntries>();

  async function getDir(dir: URL): Promise<DirEntries> {
    const key = dir.toString();
    const cached = dirCache.get(key);
    if (cached) return cached;
    const listed = await listRemote(dir, loader);
    dirCache.set(key, listed);
    return listed;
  }

  async function matchPath(path: string): Promise<RouteMatch> {
    const parts = path.split("/").filter(Boolean);
    let curDir = routesRootUrl;
    const params: Record<string, string> = {};

    const rootEntries = await getDir(curDir);
    let catchAllUrl: URL | null = null;
    if (findFileBaseMatch(rootEntries.files, "[...slug]")) catchAllUrl = new URL("[...slug].ts", curDir);

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const entries = await getDir(curDir);

      if (i === parts.length - 1) {
        const directName = findFileBaseMatch(entries.files, seg);
        if (directName) {
          return { route: { pattern: "/" + parts.join("/"), segments: toSegments("/" + parts.join("/")), fileUrl: new URL(directName, curDir) }, params };
        }
        const paramName = [...entries.files].find((f) => /^\[[^\.]+\]\.(tsx?|jsx?)$/.test(f));
        if (paramName) {
          const name = paramName.match(/^\[(.+)\]\./)?.[1] ?? "param";
          params[name] = decodeURIComponent(seg);
          const pattern = "/" + [...parts.slice(0, -1), ":" + name].join("/");
          return { route: { pattern, segments: toSegments(pattern), fileUrl: new URL(paramName, curDir) }, params };
        }
      }

      if (entries.dirs.has(seg)) {
        curDir = new URL(seg + "/", curDir);
        const dirEntries = await getDir(curDir);
        if (findFileBaseMatch(dirEntries.files, "[...slug]")) catchAllUrl = new URL("[...slug].ts", curDir);
        continue;
      }
      const pdir = [...entries.dirs].find((d) => /^\[[^\.]+\]$/.test(d));
      if (pdir) {
        const name = pdir.slice(1, -1);
        params[name] = decodeURIComponent(seg);
        curDir = new URL(pdir + "/", curDir);
        const dirEntries = await getDir(curDir);
        if (findFileBaseMatch(dirEntries.files, "[...slug]")) catchAllUrl = new URL("[...slug].ts", curDir);
        continue;
      }
      break;
    }

    const finalEntries = await getDir(curDir);
    const indexName = findFileBaseMatch(finalEntries.files, "index");
    if (indexName) {
      return { route: { pattern: "/" + parts.join("/"), segments: toSegments("/" + parts.join("/")), fileUrl: new URL(indexName, curDir) }, params };
    }

    if (catchAllUrl) {
      params.slug = parts.join("/");
      return { route: { pattern: "/*", segments: toSegments("/*"), fileUrl: catchAllUrl }, params };
    }

    return null;
  }

  return {
    routes: [],
    match: (_path: string) => null,
    __asyncMatch: matchPath,
  } as unknown as Router & { __asyncMatch: (path: string) => Promise<RouteMatch> };
} 