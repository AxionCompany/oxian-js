import { join, toFileUrl, fromFileUrl } from "@std/path";
import type { Loader } from "./types.ts";
import { detectMediaType } from "./types.ts";

export function createLocalLoader(root: URL): Loader {
  const rootUrl = root;
  return {
    scheme: "local",
    canHandle: (url: URL) => {
      return url.protocol === "file:" && url.pathname.startsWith(rootUrl.pathname)
    },
    async load(url: URL) {
      const path = fromFileUrl(url);
      const content = await Deno.readTextFile(path);
      const mediaType = detectMediaType(url.pathname);
      return { content, mediaType };
    },
    async listDir(url: URL) {
      const entries: string[] = [];
      const path = fromFileUrl(url);
      for await (const entry of Deno.readDir(path)) {
        entries.push(entry.name);
      }
      return entries;
    },
    async stat(url: URL) {
      const path = fromFileUrl(url);
      const s = await Deno.stat(path);
      return { isFile: s.isFile, mtime: s.mtime?.getTime() };
    },
    cacheKey(url: URL) {
      return url.toString();
    },
  };
}

export function resolveLocalUrl(root: string | URL, ...segments: string[]): URL {
  // If root is a string that looks like a URL, resolve segments against it
  if (typeof root === "string") {
    try {
      const base = new URL(root);
      const withSlash = base.toString().endsWith("/") ? base : new URL(base.toString() + "/");
      const combined = segments.join("/");
      return new URL(combined, withSlash);
    } catch {
      // Not a URL string, treat as filesystem path
      const path = join(root, ...segments);
      return toFileUrl(path);
    }
  }
  // Root is a URL
  const withSlash = root.toString().endsWith("/") ? root : new URL(root.toString() + "/");
  const combined = segments.join("/");
  return new URL(combined, withSlash);
}