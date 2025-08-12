import { fromFileUrl, toFileUrl } from "@std/path";

export function getRootUrl(root: string | URL | undefined): URL {
  if (!root) return toFileUrl(Deno.cwd());
  if (root instanceof URL) return root;
  try {
    return new URL(root);
  } catch {
    return toFileUrl(root);
  }
}

export function getLocalRootPath(root: string | URL | undefined): string {
  if (!root) return Deno.cwd();
  try {
    const u = root instanceof URL ? root : new URL(root);
    if (u.protocol === "file:") return fromFileUrl(u);
    // Non-file URL has no local path; fallback to cwd
    return Deno.cwd();
  } catch {
    // Not a URL, assume filesystem path
    return String(root);
  }
}


