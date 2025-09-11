import { join, toFileUrl } from "@std/path";
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
    let child: URL;
    if (dir.protocol === "github:") {
      const basePath = dir.pathname;
      const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${name}`;
      const abs = `${dir.protocol}${joinedPath.replace(/^\//, "")}${dir.search}`;
      child = new URL(abs);
    } else {
      const baseObj = new URL(dir.toString());
      baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
      child = new URL(name, baseObj);
    }
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
              fileUrl: toFileUrl(join(curDir, directFile)),
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
            route: { pattern: "/" + patternParts.join("/"), segments: toSegments("/" + patternParts.join("/")), fileUrl: toFileUrl(join(curDir, paramFile)) },
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
          fileUrl: toFileUrl(join(curDir, indexFile)),
        },
        params,
      };
    }

    if (catchAllFile) {
      params["slug"] = parts.join("/");
      return {
        route: { pattern: "/*", segments: toSegments("/*"), fileUrl: toFileUrl(catchAllFile) },
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
    if (findFileBaseMatch(rootEntries.files, "[...slug]")) {
      if (curDir.protocol === "github:") {
        const basePath = curDir.pathname;
        const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}[...slug].ts`;
        const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
        catchAllUrl = new URL(abs);
      } else {
        const baseObj = new URL(curDir.toString());
        baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
        catchAllUrl = new URL("[...slug].ts", baseObj);
      }
    }

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const entries = await getDir(curDir);

      if (i === parts.length - 1) {
        const directName = findFileBaseMatch(entries.files, seg);
        if (directName) {
          let fileUrl: URL;
          if (curDir.protocol === "github:") {
            const basePath = curDir.pathname;
            const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${directName}`;
            const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
            fileUrl = new URL(abs);
          } else {
            const baseObj = new URL(curDir.toString());
            baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
            fileUrl = new URL(directName, baseObj);
          }
          return { route: { pattern: "/" + parts.join("/"), segments: toSegments("/" + parts.join("/")), fileUrl }, params };
        }
        const paramName = [...entries.files].find((f) => /^\[[^\.]+\]\.(tsx?|jsx?)$/.test(f));
        if (paramName) {
          const name = paramName.match(/^\[(.+)\]\./)?.[1] ?? "param";
          params[name] = decodeURIComponent(seg);
          const pattern = "/" + [...parts.slice(0, -1), ":" + name].join("/");
          let fileUrl: URL;
          if (curDir.protocol === "github:") {
            const basePath = curDir.pathname;
            const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${paramName}`;
            const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
            fileUrl = new URL(abs);
          } else {
            const baseObj = new URL(curDir.toString());
            baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
            fileUrl = new URL(paramName, baseObj);
          }
          return { route: { pattern, segments: toSegments(pattern), fileUrl }, params };
        }
      }

      if (entries.dirs.has(seg)) {
        if (curDir.protocol === "github:") {
          const basePath = curDir.pathname;
          const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${seg}/`;
          const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
          curDir = new URL(abs);
        } else {
          const baseObj = new URL(curDir.toString());
          baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
          curDir = new URL(seg + "/", baseObj);
        }
        const dirEntries = await getDir(curDir);
        if (findFileBaseMatch(dirEntries.files, "[...slug]")) {
          if (curDir.protocol === "github:") {
            const basePath = curDir.pathname;
            const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}[...slug].ts`;
            const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
            catchAllUrl = new URL(abs);
          } else {
            const baseObj = new URL(curDir.toString());
            baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
            catchAllUrl = new URL("[...slug].ts", baseObj);
          }
        }
        continue;
      }
      const pdir = [...entries.dirs].find((d) => /^\[[^\.]+\]$/.test(d));
      if (pdir) {
        const name = pdir.slice(1, -1);
        params[name] = decodeURIComponent(seg);
        if (curDir.protocol === "github:") {
          const basePath = curDir.pathname;
          const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${pdir}/`;
          const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
          curDir = new URL(abs);
        } else {
          const baseObj = new URL(curDir.toString());
          baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
          curDir = new URL(pdir + "/", baseObj);
        }
        const dirEntries = await getDir(curDir);
        if (findFileBaseMatch(dirEntries.files, "[...slug]")) {
          if (curDir.protocol === "github:") {
            const basePath = curDir.pathname;
            const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}[...slug].ts`;
            const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
            catchAllUrl = new URL(abs);
          } else {
            const baseObj = new URL(curDir.toString());
            baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
            catchAllUrl = new URL("[...slug].ts", baseObj);
          }
        }
        continue;
      }
      break;
    }

    const finalEntries = await getDir(curDir);
    const indexName = findFileBaseMatch(finalEntries.files, "index");
    if (indexName) {
      let fileUrl: URL;
      if (curDir.protocol === "github:") {
        const basePath = curDir.pathname;
        const joinedPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${indexName}`;
        const abs = `github:${joinedPath.replace(/^\//, "")}${curDir.search}`;
        fileUrl = new URL(abs);
      } else {
        const baseObj = new URL(curDir.toString());
        baseObj.pathname = baseObj.pathname.endsWith("/") ? baseObj.pathname : baseObj.pathname + "/";
        fileUrl = new URL(indexName, baseObj);
      }
      return { route: { pattern: "/" + parts.join("/"), segments: toSegments("/" + parts.join("/")), fileUrl }, params };
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