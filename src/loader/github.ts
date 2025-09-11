import type { Loader } from "./types.ts";

export function parseGithubUrl(input: URL): { owner: string; repo: string; ref: string; path: string } | null {
  if (input.protocol === "github:") {
    const [owner, repo, ...rest] = input.pathname.replace(/^\//, "").split("/");
    const path = rest.join("/");
    const ref = input.searchParams.get("ref") ?? "main";
    return owner && repo ? { owner, repo, ref, path } : null;
  }
  if (input.protocol === "https:" && input.hostname === "github.com") {
    const parts = input.pathname.replace(/^\//, "").split("/");
    const [owner, repo, _type, ref, ...rest] = parts;
    if (!owner || !repo) return null;
    const path = rest.join("/");
    const effectiveRef = ref ?? "main";
    return { owner, repo, ref: effectiveRef, path };
  }
  return null;
}

export function createGithubLoader(tokenEnv?: string, tokenValue?: string): Loader {
  const token = tokenValue ?? (tokenEnv ? Deno.env.get(tokenEnv) : undefined);
  async function ghFetch(url: URL): Promise<Response> {
    const headers: HeadersInit = {
      Accept: "application/vnd.github+json",
      "User-Agent": "oxian-js/0.0.1",
    };
    if (token) headers["Authorization"] = `token ${token}`;
    const res = await fetch(url, { headers });
    return res;
  }

  return {
    scheme: "github",
    canHandle: (url: URL) => url.protocol === "github:" || (url.protocol === "https:" && url.hostname === "github.com"),
    async load(url: URL) {
      const parsed = parseGithubUrl(url);
      if (!parsed) throw new Error(`Unsupported GitHub URL: ${url}`);
      const { owner, repo, ref, path } = parsed;
      const rawUrl = new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`);
      const headers: HeadersInit = token ? { Authorization: `token ${token}` } : {};
      const res = await fetch(rawUrl, { headers });
      if (!res.ok) throw new Error(`GitHub load failed ${res.status} for ${rawUrl}`);
      const content = await res.text();
      let mediaType: "ts" | "js" | "tsx" | "jsx" | "json" = "js";
      if (path.endsWith(".ts")) mediaType = "ts";
      else if (path.endsWith(".tsx")) mediaType = "tsx";
      else if (path.endsWith(".jsx")) mediaType = "jsx";
      else if (path.endsWith(".json")) mediaType = "json";
      return { content, mediaType };
    },
    async listDir(url: URL) {
      const parsed = parseGithubUrl(url);
      if (!parsed) return [];
      const { owner, repo, ref, path } = parsed;
      const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
      api.searchParams.set("ref", ref);
      const res = await ghFetch(api);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`GitHub listDir failed ${res.status} for ${api}`);
      const json = await res.json() as Array<{ name: string; type: string }>;
      return Array.isArray(json) ? json.map((e) => e.name) : [];
    },
    async stat(url: URL) {
      const parsed = parseGithubUrl(url);
      if (!parsed) return { isFile: false };
      const { owner, repo, ref, path } = parsed;
      const api = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`);
      api.searchParams.set("ref", ref);
      const res = await ghFetch(api);
      if (res.status === 404) return { isFile: false };
      if (!res.ok) throw new Error(`GitHub stat failed ${res.status} for ${api}`);
      const json = await res.json() as { type: string } | { message: string };
      if ((json as any).type === "file") {
        // Try to get last commit date for mtime
        const commits = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
        commits.searchParams.set("path", path);
        commits.searchParams.set("sha", ref);
        commits.searchParams.set("per_page", "1");
        const cr = await ghFetch(commits);
        let mtime: number | undefined = undefined;
        if (cr.ok) {
          const arr = await cr.json() as Array<{ commit: { author: { date: string } } }>;
          const date = arr?.[0]?.commit?.author?.date;
          if (date) mtime = new Date(date).getTime();
        }
        return { isFile: true, mtime };
      }
      return { isFile: false };
    },
  } as Loader;
} 