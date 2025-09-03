import type { Loader } from "./types.ts";
import { createLocalLoader, resolveLocalUrl } from "./local.ts";
import { createGithubLoader } from "./github.ts";
import { createHttpLoader } from "./http.ts";
import { isAbsolute, toFileUrl } from "@std/path";

export type LoaderManager = {
  resolveUrl: (pathOrUrl: string) => URL;
  getActiveLoader: (url: URL) => Loader;
  getLoaders: () => Loader[];
};

export function createLoaderManager(root: string | URL, tokenEnv?: string): LoaderManager {
  const rootUrl = typeof root === "string" ? (() => { try { return new URL(root); } catch { return toFileUrl(root); } })() : root;
  const local = createLocalLoader(rootUrl);
  const github = createGithubLoader(tokenEnv);
  const http = createHttpLoader();
  const loaders = [
    local,
    github,
    http
  ];
  return {
    resolveUrl(pathOrUrl: string): URL {
      if (Deno.env.get("OXIAN_DEBUG") === "1") {
        console.log('[loader] resolveUrl(input)', { pathOrUrl, root: rootUrl.toString ? rootUrl.toString() : String(rootUrl) });
      }
      try {
        const u = new URL(pathOrUrl);
        if (Deno.env.get("OXIAN_DEBUG") === "1") {
          console.log('[loader] resolveUrl(parsed)', { href: u.toString(), protocol: u.protocol });
        }
        return u;
      } catch {
        if (isAbsolute(pathOrUrl) || /^[a-zA-Z]:[\\\/]/.test(pathOrUrl)) {
          const f = toFileUrl(pathOrUrl);
          if (Deno.env.get("OXIAN_DEBUG") === "1") {
            console.log('[loader] resolveUrl(fileUrl)', { href: f.toString() });
          }
          return f;
        }
        const r = resolveLocalUrl(rootUrl, pathOrUrl);
        if (Deno.env.get("OXIAN_DEBUG") === "1") {
          console.log('[loader] resolveUrl(local)', { href: r.toString() });
        }
        return r;
      }
    },
    getActiveLoader(url: URL): Loader {
      return loaders.find((l) => l.canHandle(url)) ?? local;
    },
    getLoaders() {
      return loaders;
    },
  };
} 