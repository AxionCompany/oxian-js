import { fromFileUrl, isAbsolute, join, toFileUrl } from "@std/path";
import { importModule } from "./importer.ts";
import { absolutize } from "../utils/root.ts";

// Minimal KV interface replacement
interface MinimalKv {
  get<T>(key: readonly unknown[]): Promise<{ value: T | null; ts?: number }>;
  set(key: readonly unknown[], value: unknown): Promise<void>;
}

class FileKv implements MinimalKv {
  private path: string;
  private mem: Record<string, { value: unknown; ts: number }> = {};
  private loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  private async load(force = false) {
    if (this.loaded && !force) return;
    try {
      const txt = await Deno.readTextFile(this.path);
      this.mem = JSON.parse(txt);
    } catch {
      this.mem = {};
    }
    this.loaded = true;
  }

  private async flush() {
    try {
      await Deno.writeTextFile(this.path, JSON.stringify(this.mem, null, 2));
    } catch { /* ignore write errors (e.g. no permissions) */ }
  }

  async get<T>(key: readonly unknown[]): Promise<{ value: T | null; ts?: number }> {
    await this.load();
    // If missing in memory, try one fresh load just in case another process wrote it
    let k = JSON.stringify(key);
    if (!this.mem[k]) {
        await this.load(true);
        k = JSON.stringify(key);
    }
    const entry = this.mem[k];
    return { value: (entry?.value as T) ?? null, ts: entry?.ts };
  }

  async set(key: readonly unknown[], value: unknown): Promise<void> {
    // Always load fresh before set to avoid overwriting other processes' updates
    await this.load(true);
    const k = JSON.stringify(key);
    this.mem[k] = { value, ts: Date.now() };
    await this.flush();
  }
}

let kvCache: MinimalKv | null = null;
async function getKvCache(): Promise<MinimalKv> {
  if (!kvCache) {
    const kvDir = join(Deno.cwd(), ".deno");
    try {
      await Deno.mkdir(kvDir, { recursive: true });
    } catch { /* ignore */ }
    const kvPath = join(kvDir, "resolver_cache.json");
    kvCache = new FileKv(kvPath);
  }
  return kvCache;
}

// Helper to serialize/deserialize complex values for KV storage
function serializeForKv(value: unknown): string {
  if (value instanceof URL) {
    return JSON.stringify({ __type: "URL", href: value.href });
  }
  return JSON.stringify(value);
}

function deserializeFromKv(
  serialized: string,
  type: "url" | "array" | "object",
): unknown {
  const parsed = JSON.parse(serialized);
  if (type === "url" && parsed.__type === "URL") {
    return new URL(parsed.href);
  }
  return parsed;
}

export function parseGithubUrl(
  specifier: string | URL,
  baseUrl: URL,
): { owner: string; repo: string; ref: string; path: string } | null {
  // Prioritize specifier full URL if it's raw.githubusercontent.com over github.com
  try {
    const specUrl = specifier instanceof URL
      ? specifier
      : ((typeof specifier === "string" &&
          (specifier.startsWith("http:") || specifier.startsWith("https:")))
        ? new URL(specifier)
        : undefined);
    if (
      specUrl?.protocol === "https:" &&
      specUrl.hostname === "raw.githubusercontent.com"
    ) {
      const input = specUrl;
      const parts = input.pathname.split("/").filter(Boolean);
      const [owner, repo, _1, _2, ref, ...path] = parts;
      if (!owner || !repo || !ref || !path.length) return null;
      return { owner, repo, ref, path: path.join("/") };
    }
  } catch { /* ignore */ }

  // Parse github: base URLs
  if (baseUrl.protocol === "github:") {
    const specStr = specifier instanceof URL
      ? specifier.toString()
      : String(specifier ?? "");
    const input = new URL(
      `https://github.com/${baseUrl.pathname}/${specStr}?${baseUrl.searchParams.toString()}`,
    );
    const [owner, repo, ...rest] = input.pathname.split("/").filter(Boolean);
    const path = rest.join("/");
    const ref = input.searchParams.get("ref") ?? "main";
    return owner && repo ? { owner, repo, ref, path } : null;
  }
  // Parse github.com base URLs
  if (baseUrl.protocol === "https:" && baseUrl.hostname === "github.com") {
    const input = new URL(
      specifier instanceof URL ? specifier.toString() : String(specifier ?? ""),
      baseUrl,
    );
    const parts = input.pathname.split("/").filter(Boolean);
    const [owner, repo, _type, ref, ...rest] = parts;
    if (!owner || !repo) return null;
    const path = rest.join("/");
    const effectiveRef = ref ?? input.searchParams.get("ref") ?? "main";
    return { owner, repo, ref: effectiveRef, path };
  }
  // Parse raw.githubusercontent.com base URLs
  if (
    baseUrl.protocol === "https:" &&
    baseUrl.hostname === "raw.githubusercontent.com"
  ) {
    const input = new URL(
      specifier instanceof URL ? specifier.toString() : String(specifier ?? ""),
      baseUrl,
    );
    const parts = input.pathname.split("/").filter(Boolean);
    const [owner, repo, _1, _2, ref, ...pathParts] = parts;
    const path = pathParts.join("/");
    if (!owner || !repo || !ref || !path) return null;
    return { owner, repo, ref, path };
  }
  // Return null if no match
  return null;
}

export interface Resolver {
  scheme: "local" | "http" | "github";
  canHandle: (input: string | URL) => boolean;
  listDir: (dir: URL) => Promise<string[]>;
  stat: (url: URL) => Promise<{ isFile: boolean }>;
  resolve: (specifier: string | URL) => Promise<URL>;
  import: (specifier: string | URL) => Promise<Record<string, unknown>>;
  load: (
    url: URL,
    opts: { encoding?: string | null },
  ) => Promise<string | Uint8Array>;
  // Optional materialize method: downloads remote sources to a local directory and returns the rootDir
  materialize?: (
    opts?: { dir?: string; refresh?: boolean },
  ) => Promise<{ rootDir: URL; ref?: string; sha?: string; subdir?: string }>;
}

// Main entry point for creating a resolver
export function createResolver(
  baseUrl: URL | string | undefined,
  opts: {
    tokenEnv?: string;
    tokenValue?: string;
    ttlMs?: number;
    forceReload?: boolean;
    invalidateAt?: number;
  },
): Resolver {
  let type: "local" | "http" | "github" = "local";
  const forceReload = opts.forceReload ?? false;
  const invalidateAt = opts.invalidateAt;

  try {
    if (baseUrl && !(baseUrl instanceof URL)) {
      baseUrl = new URL(baseUrl);
    }
  } catch { /* ignore */ }

  if (baseUrl instanceof URL && baseUrl.protocol) {
    switch (baseUrl.protocol) {
      case "file:":
        type = "local";
        break;
      case "github:":
        type = "github";
        break;
      case "http:":
      case "https:":
        type = "http";
        break;
    }
  } else type = "local";

  const resolverMap = {
    local: createLocalResolver(baseUrl as URL),
    http: createHttpResolver(baseUrl as URL),
    github: createGithubResolver(baseUrl as URL, {
      tokenEnv: opts.tokenEnv,
      tokenValue: opts.tokenValue,
    }),
  };

  const baseKey = baseUrl instanceof URL
    ? baseUrl.toString()
    : String(baseUrl ?? Deno.cwd());
  const cacheKey = (
    op: string,
    spec: string | URL,
  ) => ["resolver_cache", op, baseKey, spec?.toString()];

  // Helper to get cached value from KV
  async function getCached<T>(
    key: Deno.KvKey,
    type: "url" | "array" | "object",
  ): Promise<T | null> {
    if (forceReload) return null;
    const kv = await getKvCache();
    const entry = await kv.get<string>(key);
    if (!entry.value) return null;
    if (invalidateAt && entry.ts && entry.ts < invalidateAt) return null;
    return deserializeFromKv(entry.value, type) as T;
  }

  // Helper to set cached value in KV
  async function setCached(key: Deno.KvKey, value: unknown): Promise<void> {
    const kv = await getKvCache();
    const serialized = serializeForKv(value);
    await kv.set(key, serialized);
  }

  const resolver: Resolver = {
    scheme: type,
    canHandle: (input: string | URL) => {
      try {
        const u = input instanceof URL ? input : new URL(String(input));
        if (type === "local") return u.protocol === "file:";
        if (type === "http") {
          return u.protocol === "http:" || u.protocol === "https:";
        }
        if (type === "github") {
          return u.protocol === "github:" || u.hostname === "github.com" ||
            u.hostname === "raw.githubusercontent.com";
        }
        return false;
      } catch {
        return typeof input === "string";
      }
    },
    resolve: async (specifier: string | URL) => {
      // bypass cache for local files
      if (type === "local") {
        return resolverMap[type].resolve(specifier);
      }
      const key = cacheKey("resolve", specifier);
      const cached = await getCached<URL>(key, "url");
      if (cached) return cached;
      if (!resolverMap[type]) {
        throw new Error(
          `Resolver not found for type: ${type}, ${specifier?.toString()}, ${
            baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl)
          }`,
        );
      }
      const url = await resolverMap[type].resolve(specifier as string | URL);
      await setCached(key, url);
      return url;
    },
    listDir: async (specifier: URL) => {
      // bypass cache for local files
      if (type === "local") {
        return resolverMap[type].listDir(specifier);
      }
      const key = cacheKey("listDir", specifier);
      const cached = await getCached<string[]>(key, "array");
      if (cached) return cached;
      if (!resolverMap[type]) {
        throw new Error(
          `Resolver not found for type: ${type}, ${specifier?.toString()}, ${
            baseUrl instanceof URL ? baseUrl.toString() : String(baseUrl)
          }`,
        );
      }
      const listDir = await resolverMap[type].listDir(
        await resolver.resolve(specifier),
      );
      const array = Array.isArray(listDir)
        ? listDir
        : Array.from(listDir as unknown as Iterable<string>);
      await setCached(key, array);
      return array;
    },
    stat: async (specifier: URL) => {
      // bypass cache for local files
      if (type === "local") {
        return resolverMap[type].stat(specifier);
      }
      const key = cacheKey("stat", specifier);
      const cached = await getCached<{ isFile: boolean }>(key, "object");
      if (cached) return cached;
      if (!resolverMap[type]) {
        throw new Error(`Resolver not found for type: ${type}`);
      }
      const stat = await resolverMap[type].stat(
        await resolver.resolve(specifier),
      );
      await setCached(key, stat);
      return stat;
    },
    import: async (specifier: string | URL) => {
      // import is NOT cached as per requirements
      const mod = await importModule(
        await resolver.resolve(specifier),
        opts.ttlMs,
      );
      return mod;
    },
    load: async (
      specifier: URL,
      opts: { encoding?: string | null } = { encoding: "utf-8" },
    ) => {
      // bypass cache for local files
      if (type === "local") {
        return resolverMap[type].load(specifier, opts);
      }
      const key = cacheKey("load", specifier);
      const cached = await getCached<string | Uint8Array>(key, "object");
      if (cached) return cached;
      const content = await resolverMap[type].load(specifier, opts);
      await setCached(key, content);
      return content;
    },
    materialize: resolverMap[type] &&
        (resolverMap[type] as unknown as {
          materialize?: Resolver["materialize"];
        }).materialize
      ? async (opts?: { dir?: string; refresh?: boolean }) => {
        const matKey = cacheKey("materialize", baseUrl?.toString() ?? "");
        const cached = await getCached<
          { rootDir: URL; ref?: string; sha?: string; subdir?: string }
        >(matKey, "object");
        if (cached && !opts?.refresh && !forceReload) {
          // Reconstruct URL from cached data
          return {
            ...cached,
            rootDir: new URL(
              typeof cached.rootDir === "string"
                ? cached.rootDir
                : (cached.rootDir as URL).href,
            ),
          };
        }
        const matFn = (resolverMap[type] as unknown as {
          materialize?: Resolver["materialize"];
        }).materialize;
        if (!matFn) throw new Error("materialize not available");
        const result = await matFn(opts);
        await setCached(matKey, result);
        return result;
      }
      : undefined,
  };
  return resolver;
}

// Resolver for local files
export function createLocalResolver(baseUrl?: URL): Resolver {
  return {
    scheme: "local",
    canHandle: (input: string | URL) => {
      try {
        const u = input instanceof URL ? input : new URL(String(input));
        return u.protocol === "file:";
      } catch {
        return typeof input === "string";
      }
    },
    resolve(specifier?: string | URL) {
      if (typeof specifier === "string" && specifier.startsWith("file:")) {
        return Promise.resolve(new URL(specifier));
      }
      if (specifier instanceof URL && specifier.protocol === "file:") {
        return Promise.resolve(specifier);
      }
      if (specifier === "") return Promise.resolve(toFileUrl(Deno.cwd()));
      const specStr = String(specifier);
      if (isAbsolute(specStr)) {
        return Promise.resolve(toFileUrl(specStr));
      }
      const basePath = (baseUrl && baseUrl.protocol === "file:")
        ? fromFileUrl(baseUrl)
        : Deno.cwd();
      const joined = join(basePath, specStr);
      return Promise.resolve(toFileUrl(absolutize(joined)));
    },
    listDir(URLspecifier: URL) {
      const path = fromFileUrl(URLspecifier);
      const entries = Array.from(Deno.readDirSync(path));
      return Promise.resolve(entries.map((entry) => entry.name));
    },
    stat(URLspecifier: URL) {
      const info = Deno.statSync(fromFileUrl(URLspecifier));
      return Promise.resolve({ isFile: info.isFile });
    },
    async load(
      URLspecifier: URL,
      opts: { encoding?: string | null } = { encoding: "utf-8" },
    ) {
      const file = await Deno.readFile(fromFileUrl(URLspecifier));
      if (opts?.encoding !== null) {
        return Promise.resolve(new TextDecoder(opts?.encoding).decode(file));
      }
      return Promise.resolve(file);
    },
    materialize: (_opts?: { dir?: string; refresh?: boolean }) => {
      const root = baseUrl && baseUrl.protocol === "file:"
        ? baseUrl
        : toFileUrl(Deno.cwd());
      return Promise.resolve({ rootDir: root });
    },
  } as unknown as Resolver;
}

// Resolver for HTTP(s)
export function createHttpResolver(baseUrl: URL): Resolver {
  return {
    scheme: "http",
    canHandle: (input: string | URL) => {
      try {
        const u = input instanceof URL ? input : new URL(String(input));
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return typeof input === "string";
      }
    },
    resolve(specifier?: string | URL) {
      if (
        typeof specifier === "string" &&
        (specifier.startsWith("http:") || specifier.startsWith("https:"))
      ) return Promise.resolve(new URL(specifier));
      if (
        specifier instanceof URL &&
        (specifier.protocol === "http:" || specifier.protocol === "https:")
      ) return Promise.resolve(specifier);
      return Promise.resolve(new URL(String(specifier), baseUrl));
    },
    // Not implemented -> Cannot list directories for HTTP(s)
    listDir(_specifier: URL) {
      return Promise.reject(new Error("http listDir not implemented"));
    },
    // Not implemented -> Cannot stat HTTP(s)
    stat(_specifier: URL) {
      return Promise.reject(new Error("http stat not implemented"));
    },
    load: (
      specifier: URL,
      _opts: { encoding?: string | null } = { encoding: "utf-8" },
    ) => {
      return fetch(specifier).then((res) => res.text());
    },
    materialize: () =>
      Promise.reject(new Error("http materialize not implemented")),
  } as unknown as Resolver;
}

// Resolver for GitHub
export function createGithubResolver(
  baseUrl: URL,
  opts: { tokenEnv?: string; tokenValue?: string },
): Resolver {
  const token = opts.tokenValue ??
    (opts.tokenEnv ? Deno.env.get(opts.tokenEnv) : undefined);
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
    canHandle: (input: string | URL) => {
      try {
        const u = input instanceof URL ? input : new URL(String(input));
        return u.protocol === "github:" || u.hostname === "github.com" ||
          u.hostname === "raw.githubusercontent.com";
      } catch {
        return typeof input === "string";
      }
    },
    resolve(specifier?: string | URL) {
      if (
        specifier instanceof URL &&
        (specifier.protocol === "http:" || specifier.protocol === "https:")
      ) return Promise.resolve(specifier);
      if (
        typeof specifier === "string" &&
        (specifier.startsWith("http:") || specifier.startsWith("https:"))
      ) return Promise.resolve(new URL(specifier));
      const parsed = parseGithubUrl(specifier ?? "", baseUrl);
      if (!parsed) {
        throw new Error(`Unsupported GitHub URL: ${String(specifier)}`);
      }
      const { owner, repo, ref, path } = parsed;
      const rawUrl = new URL(
        `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${path}`,
      );
      return Promise.resolve(rawUrl);
    },
    async listDir(URLspecifier: URL) {
      const parsed = parseGithubUrl(URLspecifier, baseUrl);
      if (!parsed) return [];
      const { owner, repo, ref, path } = parsed;
      const api = new URL(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      );
      api.searchParams.set("ref", ref);
      const res = await ghFetch(api);
      if (res.status === 404) return [];
      if (!res.ok) {
        throw new Error(`GitHub listDir failed ${res.status} for ${api}`);
      }
      const json = await res.json() as Array<{ name: string; type: string }>;
      return Array.isArray(json) ? json.map((e) => e.name) : [];
    },
    async stat(URLspecifier: URL) {
      const parsed = parseGithubUrl(URLspecifier, baseUrl);
      if (!parsed) return { isFile: false };
      const { owner, repo, ref, path } = parsed;
      const api = new URL(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      );
      api.searchParams.set("ref", ref);
      const res = await ghFetch(api);
      if (res.status === 404) return { isFile: false };
      if (!res.ok) {
        throw new Error(`GitHub stat failed ${res.status} for ${api}`);
      }
      const json = await res.json() as { type?: string } | { message?: string };
      if ((json as { type?: string }).type === "file") {
        return { isFile: true };
      }
      return { isFile: false };
    },
    load: async (
      URLspecifier: URL,
      _opts: { encoding?: string | null } = { encoding: "utf-8" },
    ) => {
      let apiUrl = URLspecifier;
      if (
        URLspecifier.protocol === "https:" &&
        URLspecifier.hostname === "raw.githubusercontent.com"
      ) {
        const [owner, repo, _1, _2, ref, ...path] = URLspecifier.pathname.split(
          "/",
        ).filter(Boolean);
        apiUrl = new URL(
          `https://api.github.com/repos/${owner}/${repo}/contents/${
            path.join("/")
          }`,
        );
        apiUrl.searchParams.set("ref", ref);
      }
      const res = await ghFetch(apiUrl);
      if (!res.ok) {
        throw new Error(`GitHub load failed ${res.status} for ${apiUrl}`);
      }
      const resJson = await res.json();
      const content = resJson.content;
      const decoded = atob(content);
      return decoded;
    },
    materialize: async (optsIn?: { dir?: string; refresh?: boolean }) => {
      const opts = optsIn ?? {};
      const parsed = parseGithubUrl("", baseUrl);
      if (!parsed) {
        throw new Error(
          `Unsupported GitHub base URL for materialize: ${baseUrl.toString()}`,
        );
      }
      const { owner, repo, ref, path } = parsed;
      // Resolve ref -> SHA
      const commitApi = new URL(
        `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`,
      );
      const commitRes = await ghFetch(commitApi);
      if (!commitRes.ok) {
        throw new Error(
          `GitHub resolve ref failed ${commitRes.status} for ${commitApi}`,
        );
      }
      const commitJson = await commitRes.json() as { sha?: string };
      const sha = commitJson.sha || ref;
      Deno.writeTextFileSync("resolver.txt", `opts.dir: ${String(opts.dir)}`, {
        append: true,
      });
      const dirInput = opts.dir ? String(opts.dir) : ".";
      Deno.writeTextFileSync("resolver.txt", `dirInput: ${String(dirInput)}`, {
        append: true,
      });
      const dirAbs = isAbsolute(dirInput)
        ? dirInput
        : join(Deno.cwd(), dirInput);
      Deno.writeTextFileSync("resolver.txt", `dirAbs: ${String(dirAbs)}`, {
        append: true,
      });
      const rootPath = `${dirAbs.replace(/\/$/, "")}`;
      Deno.writeTextFileSync("resolver.txt", `rootPath: ${String(rootPath)}`, {
        append: true,
      });
      try {
        Deno.mkdirSync(rootPath, { recursive: true });
      } catch { /* ignore */ }
      Deno.writeTextFileSync(
        "resolver.txt",
        `Created dir: ${String(rootPath)}`,
        { append: true },
      );
      const marker = `${rootPath}/.ok`;
      Deno.writeTextFileSync("resolver.txt", `marker: ${String(marker)}`, {
        append: true,
      });
      const exists = (() => {
        try {
          return Deno.statSync(marker).isFile;
        } catch {
          return false;
        }
      })();
      if (exists && !opts.refresh) {
        const base = toFileUrl(rootPath + "/");
        const subdir = path ? path : undefined;
        return {
          rootDir: subdir
            ? new URL(subdir.replace(/^\/?/, "") + "/", base)
            : base,
          ref,
          sha,
          subdir,
        };
      }
      // Download tarball
      const tarUrl = new URL(
        `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`,
      );
      const tarRes = await ghFetch(tarUrl);
      if (!tarRes.ok) {
        throw new Error(`GitHub tarball failed ${tarRes.status} for ${tarUrl}`);
      }
      const reader = tarRes.body?.getReader();
      if (!reader) throw new Error("No response body from GitHub tarball");
      // Stream to temp file to simplify extraction
      const tmpTar = `${rootPath}.tar.gz.tmp`;
      Deno.writeTextFileSync("resolver.txt", `tmpTar: ${String(tmpTar)}`, {
        append: true,
      });
      const file = await Deno.open(tmpTar, {
        create: true,
        write: true,
        truncate: true,
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) await file.write(value);
        }
      } finally {
        try {
          file.close();
        } catch { /* ignore */ }
      }
      // Decompress and extract using built-ins
      const gz = await Deno.readFile(tmpTar);
      Deno.writeTextFileSync("resolver.txt", `gz: ${String(gz)}`, {
        append: true,
      });
      // Use Web Streams DecompressionStream where available
      const ds = new DecompressionStream("gzip");
      const decompressed = await new Response(
        new Blob([gz]).stream().pipeThrough(ds),
      ).arrayBuffer();
      Deno.writeTextFileSync(
        "resolver.txt",
        `decompressed: ${String(decompressed).slice(0, 100)}...`,
        { append: true },
      );
      // Minimal tar extractor: skip leading folder, safe paths only
      await extractMinimalTar(new Uint8Array(decompressed), rootPath);
      Deno.writeTextFileSync(
        "resolver.txt",
        `extracted: ${
          JSON.stringify({
            owner,
            repo,
            ref,
            sha,
            at: new Date().toISOString(),
          })
        }`,
        { append: true },
      );
      try {
        await Deno.writeTextFile(
          marker,
          JSON.stringify({
            owner,
            repo,
            ref,
            sha,
            at: new Date().toISOString(),
          }),
        );
      } catch { /* ignore */ }
      try {
        await Deno.remove(tmpTar);
      } catch { /* ignore */ }
      const base = toFileUrl(rootPath + "/");
      const subdir = path ? path : undefined;
      return {
        rootDir: subdir
          ? new URL(subdir.replace(/^\/?/, "") + "/", base)
          : base,
        ref,
        sha,
        subdir,
      };
    },
  } as unknown as Resolver;
}

// Minimal tar extractor sufficient for GitHub tarballs
async function extractMinimalTar(
  bytes: Uint8Array,
  destDir: string,
): Promise<void> {
  // Robust tar reader: supports POSIX ustar, PAX headers, and GNU longnames. Extracts regular files and directories.
  const blockSize = 512;
  let offset = 0;
  const decoder = new TextDecoder();
  function nulTerminated(s: string): string {
    const idx = s.indexOf("\0");
    return idx >= 0 ? s.slice(0, idx) : s;
  }
  function parseOctal(str: string): number {
    const s = nulTerminated(str).trim();
    return s ? parseInt(s, 8) : 0;
  }

  let pendingPaxPath: string | null = null;
  let pendingLongName: string | null = null;

  while (offset + blockSize <= bytes.length) {
    const block = bytes.subarray(offset, offset + blockSize);
    offset += blockSize;

    const rawName = nulTerminated(decoder.decode(block.subarray(0, 100)));
    const size = parseOctal(decoder.decode(block.subarray(124, 136)));
    const typeflagCode = block[156] || 0;
    const typeflag = String.fromCharCode(typeflagCode);
    const prefix = nulTerminated(decoder.decode(block.subarray(345, 500)));

    // End of archive: empty header
    if (!rawName && size === 0 && typeflagCode === 0) {
      // Skip to next header (usually another zero block) and continue
      continue;
    }

    // Handle PAX extended header (type 'x'): applies to the NEXT header
    if (typeflag === "x") {
      const paxBytes = bytes.subarray(offset, offset + size);
      const paxText = new TextDecoder().decode(paxBytes);
      const lines = paxText.split("\n");
      for (const line of lines) {
        const spaceIdx = line.indexOf(" ");
        const kv = spaceIdx >= 0 ? line.slice(spaceIdx + 1) : line;
        const eqIdx = kv.indexOf("=");
        if (eqIdx >= 0) {
          const key = kv.slice(0, eqIdx);
          const value = kv.slice(eqIdx + 1);
          if (key === "path") pendingPaxPath = value;
        }
      }
      const pad = (blockSize - (size % blockSize)) % blockSize;
      offset += size + pad;
      continue;
    }

    // Handle GNU longname (type 'L'): name for the NEXT header
    if (typeflag === "L") {
      const nameBytes = bytes.subarray(offset, offset + size);
      let longName = new TextDecoder().decode(nameBytes);
      const nulIdx = longName.indexOf("\0");
      if (nulIdx >= 0) longName = longName.slice(0, nulIdx);
      pendingLongName = longName;
      const pad = (blockSize - (size % blockSize)) % blockSize;
      offset += size + pad;
      continue;
    }

    // Build effective name
    let headerName = rawName;
    if (prefix) headerName = `${prefix}/${headerName}`;
    if (pendingLongName) {
      headerName = pendingLongName;
      pendingLongName = null;
    }
    if (pendingPaxPath) {
      headerName = pendingPaxPath;
      pendingPaxPath = null;
    }

    // Compute path without the top-level folder
    const parts = headerName.split("/").filter(Boolean);
    const safe = parts.slice(1).filter((p) => p !== "." && p !== "..").join(
      "/",
    );
    const isDirectory = typeflag === "5" || headerName.endsWith("/");
    const isRegularFile =
      (typeflag === "0" || typeflag === "\0" || typeflag === "") &&
      !isDirectory;

    // If no safe path (e.g., top-level folder only), just skip payload
    if (!safe) {
      const pad = (blockSize - (size % blockSize)) % blockSize;
      offset += size + pad;
      continue;
    }

    const fullPath = `${destDir}/${safe}`;

    if (isDirectory) {
      try {
        Deno.mkdirSync(fullPath, { recursive: true });
      } catch { /* ignore */ }
      const pad = (blockSize - (size % blockSize)) % blockSize;
      offset += size + pad;
      continue;
    }

    if (isRegularFile) {
      // Ensure parent directory exists
      const dir = fullPath.replace(/\/[^/]*$/, "");
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch { /* ignore */ }

      // If a directory exists at file path, skip writing (defensive)
      try {
        const st = Deno.statSync(fullPath);
        if (st.isDirectory) {
          const pad = (blockSize - (size % blockSize)) % blockSize;
          offset += size + pad;
          continue;
        }
      } catch { /* not exists, proceed */ }

      const content = bytes.subarray(offset, offset + size);
      await Deno.writeFile(fullPath, content);
      const pad = (blockSize - (size % blockSize)) % blockSize;
      offset += size + pad;
      continue;
    }

    // Other types (symlink, hardlink, etc.) — skip payload
    const pad = (blockSize - (size % blockSize)) % blockSize;
    offset += size + pad;
  }
}
