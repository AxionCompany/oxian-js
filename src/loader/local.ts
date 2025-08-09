import { join, toFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import type { Loader } from "./types.ts";
import { detectMediaType } from "./types.ts";

export function createLocalLoader(root: string): Loader {
  const rootUrl = toFileUrl(root.endsWith("/") ? root : root + "/");
  return {
    scheme: "local",
    canHandle: (url: URL) => url.protocol === rootUrl.protocol && url.pathname.startsWith(rootUrl.pathname),
    async load(url: URL) {
      const path = url.protocol === "file:" ? url : toFileUrl(url.toString());
      const content = await Deno.readTextFile(path);
      const mediaType = detectMediaType(url.pathname);
      return { content, mediaType };
    },
    async listDir(url: URL) {
      const entries: string[] = [];
      const path = url.protocol === "file:" ? url : toFileUrl(url.toString());
      for await (const entry of Deno.readDir(path)) {
        entries.push(entry.name);
      }
      return entries;
    },
    async stat(url: URL) {
      const path = url.protocol === "file:" ? url : toFileUrl(url.toString());
      const s = await Deno.stat(path);
      return { isFile: s.isFile, mtime: s.mtime?.getTime() };
    },
    cacheKey(url: URL) {
      return url.toString();
    },
  };
}

export function resolveLocalUrl(root: string, ...segments: string[]): URL {
  const path = join(root, ...segments);
  return toFileUrl(path);
} 