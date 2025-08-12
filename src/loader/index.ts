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
      try {
        return new URL(pathOrUrl);
      } catch {
        if (isAbsolute(pathOrUrl)) return toFileUrl(pathOrUrl);
        return resolveLocalUrl(rootUrl, pathOrUrl);
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