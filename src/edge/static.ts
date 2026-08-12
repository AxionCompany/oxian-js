import {
  extname,
  fromFileUrl,
  isAbsolute,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type {
  FetchAdapter,
  FetchHandler,
  StaticAdapterOptions,
  StaticCacheControl,
} from "./types.ts";

const READ_CHUNK_BYTES = 64 * 1024;
const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "application/ogg",
  ".ogv": "video/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".text": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

type ByteRange = Readonly<{
  start: number;
  end: number;
}>;

type StaticConfiguration = Readonly<{
  root: string;
  prefix: string;
  index: readonly string[];
  fallback?: string;
  cacheControl?: string | StaticCacheControl;
  contentType?: StaticAdapterOptions["contentType"];
  fallthrough: boolean;
}>;

type OpenStaticFile = Readonly<{
  path: string;
  file: Deno.FsFile;
  info: Deno.FileInfo;
}>;

function normalizePrefix(value: string | undefined): string {
  const prefix = value ?? "/";
  if (
    !prefix.startsWith("/") ||
    prefix.includes("?") ||
    prefix.includes("#") ||
    prefix.includes("\\") ||
    prefix.includes("\0")
  ) {
    throw new TypeError("static prefix must be an absolute URL path");
  }
  const segments = prefix.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("static prefix cannot contain traversal segments");
  }
  const normalized = prefix.replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function normalizeRelativePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${label} must be a non-empty relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new TypeError(`${label} cannot contain empty or traversal segments`);
  }
  return segments.join("/");
}

function normalizeIndex(
  value: StaticAdapterOptions["index"],
): readonly string[] {
  if (value === false) return Object.freeze([]);
  const values = typeof value === "string"
    ? [value]
    : [...(value ?? ["index.html"])];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const index = normalizeRelativePath(candidate, "static index");
    if (!seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
  }
  return Object.freeze(result);
}

function withinRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" ||
    (!isAbsolute(path) &&
      path !== ".." &&
      !path.startsWith(`..${SEPARATOR}`));
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function extractRelativePath(
  decoded: string,
  prefix: string,
): readonly string[] | null {
  if (decoded.includes("\\") || decoded.includes("\0")) return null;

  let remainder: string;
  if (prefix === "/") {
    remainder = decoded.slice(1);
  } else if (decoded === prefix) {
    remainder = "";
  } else if (decoded.startsWith(`${prefix}/`)) {
    remainder = decoded.slice(prefix.length + 1);
  } else return null;

  const segments = remainder.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return Object.freeze(segments);
}

function requestMatchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname.startsWith("/");
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function createEtag(info: Deno.FileInfo): string {
  const modified = info.mtime?.getTime() ?? 0;
  return `"${info.size.toString(16)}-${Math.max(0, modified).toString(16)}"`;
}

function weakEtag(value: string): string {
  return value.trim().replace(/^W\//i, "");
}

function ifNoneMatchMatches(value: string, etag: string): boolean {
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || weakEtag(normalized) === weakEtag(etag);
  });
}

function isNotModified(request: Request, info: Deno.FileInfo, etag: string) {
  const noneMatch = request.headers.get("if-none-match");
  if (noneMatch !== null) return ifNoneMatchMatches(noneMatch, etag);

  const modifiedSince = request.headers.get("if-modified-since");
  if (modifiedSince === null || info.mtime === null) return false;
  const timestamp = Date.parse(modifiedSince);
  return Number.isFinite(timestamp) &&
    Math.floor(info.mtime.getTime() / 1_000) <= Math.floor(timestamp / 1_000);
}

function ifRangeMatches(
  request: Request,
  info: Deno.FileInfo,
  etag: string,
): boolean {
  const value = request.headers.get("if-range");
  if (value === null) return true;
  if (value.startsWith('"')) return value === etag;
  if (value.startsWith("W/")) return false;
  if (info.mtime === null) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    Math.floor(info.mtime.getTime() / 1_000) <= Math.floor(timestamp / 1_000);
}

function parseRange(value: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (match === null || (match[1] === "" && match[2] === "")) return null;

  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null;
    return Object.freeze({
      start: Math.max(0, size - suffix),
      end: size - 1,
    });
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return null;
  }
  return Object.freeze({
    start,
    end: Math.min(requestedEnd, size - 1),
  });
}

function closeFile(file: Deno.FsFile): void {
  try {
    file.close();
  } catch {
    // A completed or cancelled Deno file stream may already be closed.
  }
}

function createFileStream(
  file: Deno.FsFile,
  byteLength: number,
): ReadableStream<Uint8Array> {
  let remaining = byteLength;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeFile(file);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining === 0) {
        close();
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, remaining));
      try {
        const read = await file.read(chunk);
        if (read === null || read === 0) {
          close();
          controller.error(
            new TypeError(
              "static file ended before its advertised content length",
            ),
          );
          return;
        }
        remaining -= read;
        controller.enqueue(
          read === chunk.byteLength ? chunk : chunk.subarray(0, read),
        );
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
}

function sameTimestamp(
  left: Date | null,
  right: Date | null,
): boolean {
  return left === null
    ? right === null
    : right !== null && left.getTime() === right.getTime();
}

/**
 * Deno exposes stable device/inode identity on Unix. On platforms where those
 * fields are unavailable, the strongest portable fallback is a metadata
 * fingerprint combined with the realpath containment checks around open.
 */
function sameFileIdentity(
  left: Deno.FileInfo,
  right: Deno.FileInfo,
): boolean {
  if (
    left.dev !== null &&
    left.ino !== null &&
    right.dev !== null &&
    right.ino !== null
  ) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory &&
    left.size === right.size &&
    left.mode === right.mode &&
    sameTimestamp(left.mtime, right.mtime) &&
    sameTimestamp(left.ctime, right.ctime) &&
    sameTimestamp(left.birthtime, right.birthtime);
}

async function openVerifiedFile(
  root: string,
  path: string,
  expected: Deno.FileInfo,
): Promise<OpenStaticFile | null> {
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { read: true });
    const info = await file.stat();
    if (!info.isFile || !sameFileIdentity(expected, info)) return null;

    // Deno.open currently has no portable no-follow option and FsFile exposes
    // no canonical pathname. Re-resolve the name after opening, then prove that
    // the name still points inside the root and to the opened identity.
    const currentPath = await Deno.realPath(path);
    if (!withinRoot(root, currentPath)) return null;
    const currentInfo = await Deno.stat(currentPath);
    if (!currentInfo.isFile || !sameFileIdentity(info, currentInfo)) {
      return null;
    }

    const result = Object.freeze({ path, file, info });
    file = undefined;
    return result;
  } catch {
    return null;
  } finally {
    if (file !== undefined) closeFile(file);
  }
}

function createConfiguration(
  options: StaticAdapterOptions,
): StaticConfiguration {
  const rootValue = options.root instanceof URL
    ? (() => {
      if (options.root.protocol !== "file:") {
        throw new TypeError("static root URL must use the file: protocol");
      }
      return fromFileUrl(options.root);
    })()
    : options.root;
  if (typeof rootValue !== "string" || rootValue.length === 0) {
    throw new TypeError("static root must be a filesystem path");
  }
  const root = Deno.realPathSync(rootValue);
  if (!Deno.statSync(root).isDirectory) {
    throw new TypeError("static root must be a directory");
  }
  if (
    options.cacheControl !== undefined &&
    typeof options.cacheControl !== "string" &&
    typeof options.cacheControl !== "function"
  ) {
    throw new TypeError("static cacheControl must be a string or function");
  }
  if (
    options.contentType !== undefined &&
    typeof options.contentType !== "function"
  ) {
    throw new TypeError("static contentType must be a function");
  }
  return Object.freeze({
    root,
    prefix: normalizePrefix(options.prefix),
    index: normalizeIndex(options.index),
    ...(options.fallback === undefined ? {} : {
      fallback: normalizeRelativePath(options.fallback, "static fallback"),
    }),
    cacheControl: options.cacheControl,
    contentType: options.contentType,
    fallthrough: options.fallthrough ?? true,
  });
}

async function resolveFile(
  config: StaticConfiguration,
  segments: readonly string[],
): Promise<OpenStaticFile | null> {
  const lexical = resolve(config.root, ...segments);
  if (!withinRoot(config.root, lexical)) return null;

  let path: string;
  try {
    path = await Deno.realPath(lexical);
  } catch {
    return null;
  }
  if (!withinRoot(config.root, path)) return null;

  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    return null;
  }
  if (info.isDirectory) {
    for (const index of config.index) {
      const candidate = resolve(path, index);
      if (!withinRoot(config.root, candidate)) continue;
      try {
        const realCandidate = await Deno.realPath(candidate);
        if (!withinRoot(config.root, realCandidate)) continue;
        const candidateInfo = await Deno.stat(realCandidate);
        if (candidateInfo.isFile) {
          const opened = await openVerifiedFile(
            config.root,
            realCandidate,
            candidateInfo,
          );
          if (opened !== null) return opened;
        }
      } catch {
        // Try the next configured directory index.
      }
    }
    return null;
  }
  return info.isFile ? await openVerifiedFile(config.root, path, info) : null;
}

function cacheControl(
  policy: StaticConfiguration["cacheControl"],
  path: string,
  info: Deno.FileInfo,
): string | undefined {
  return typeof policy === "function" ? policy(path, info) : policy;
}

function baseHeaders(
  config: StaticConfiguration,
  path: string,
  info: Deno.FileInfo,
  etag: string,
): Headers {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "etag": etag,
  });
  if (info.mtime !== null) {
    headers.set("last-modified", info.mtime.toUTCString());
  }
  const type = config.contentType?.(path, info) ??
    MIME_TYPES[extname(path).toLowerCase()];
  if (type !== undefined) headers.set("content-type", type);
  const caching = cacheControl(config.cacheControl, path, info);
  if (caching !== undefined) headers.set("cache-control", caching);
  return headers;
}

async function serveFile(
  request: Request,
  config: StaticConfiguration,
  opened: OpenStaticFile,
): Promise<Response | null> {
  const { file, info, path } = opened;
  let transferred = false;
  try {
    // User-provided metadata callbacks run only after the response source has
    // been opened and verified. Path replacement cannot retarget this handle.
    const etag = createEtag(info);
    const headers = baseHeaders(config, path, info, etag);
    if (isNotModified(request, info, etag)) {
      return new Response(null, { status: 304, headers });
    }

    const rangeHeader = request.headers.get("range");
    let range: ByteRange | undefined;
    if (rangeHeader !== null && ifRangeMatches(request, info, etag)) {
      const parsed = parseRange(rangeHeader, info.size);
      if (parsed === null) {
        headers.set("content-range", `bytes */${info.size}`);
        headers.set("content-length", "0");
        return new Response(null, { status: 416, headers });
      }
      range = parsed;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    const length = range === undefined ? info.size : end - start + 1;
    headers.set("content-length", String(length));
    if (range !== undefined) {
      headers.set("content-range", `bytes ${start}-${end}/${info.size}`);
    }
    const status = range === undefined ? 200 : 206;
    if (request.method.toUpperCase() === "HEAD" || length === 0) {
      return new Response(null, { status, headers });
    }

    try {
      if (start > 0) await file.seek(start, Deno.SeekMode.Start);
    } catch {
      return null;
    }
    const response = new Response(createFileStream(file, length), {
      status,
      headers,
    });
    transferred = true;
    return response;
  } finally {
    if (!transferred) closeFile(file);
  }
}

function acceptsHtmlNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode")?.toLowerCase();
  if (mode !== undefined && mode !== "navigate") return false;
  const destination = request.headers.get("sec-fetch-dest")?.toLowerCase();
  if (destination !== undefined && destination !== "document") return false;

  const accept = request.headers.get("accept");
  if (accept === null) return false;
  return accept.split(",").some((candidate) => {
    const [mediaType, ...parameters] = candidate.trim().toLowerCase().split(
      ";",
    );
    if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      return false;
    }
    return !parameters.some((parameter) => parameter.trim() === "q=0");
  });
}

async function navigationFallback(
  request: Request,
  config: StaticConfiguration,
  response: Response,
): Promise<Response> {
  if (
    response.status !== 404 ||
    config.fallback === undefined ||
    !acceptsHtmlNavigation(request)
  ) {
    return response;
  }
  const resolved = await resolveFile(config, config.fallback.split("/"));
  if (resolved === null) return response;
  const replacement = await serveFile(request, config, resolved);
  if (replacement === null) return response;
  try {
    await response.body?.cancel("replaced by static navigation fallback");
  } catch {
    // The replacement is already independently opened and verified.
  }
  return replacement;
}

async function miss(
  request: Request,
  next: FetchHandler,
  config: StaticConfiguration,
  allowFallback = true,
): Promise<Response> {
  const response = config.fallthrough
    ? next(request)
    : new Response("Not Found", { status: 404 });
  return allowFallback
    ? await navigationFallback(request, config, await response)
    : await response;
}

/**
 * Creates a local-filesystem edge wrapper. Every candidate is checked both
 * lexically and after realpath resolution, preventing decoded traversal and
 * symlink escapes from leaving the configured root.
 */
export function createStaticAdapter(
  options: StaticAdapterOptions,
): FetchAdapter {
  const config = createConfiguration(options);
  return (next) => {
    if (typeof next !== "function") {
      throw new TypeError("static adapter expects a Fetch handler");
    }
    return async (request) => {
      const method = request.method.toUpperCase();
      if (method !== "GET" && method !== "HEAD") return await next(request);

      const encodedPathname = new URL(request.url).pathname;
      const pathname = decodePathname(encodedPathname);
      if (pathname === null) {
        return requestMatchesPrefix(encodedPathname, config.prefix)
          ? await miss(request, next, config, false)
          : await next(request);
      }
      if (!requestMatchesPrefix(pathname, config.prefix)) {
        return await next(request);
      }
      const segments = extractRelativePath(pathname, config.prefix);
      if (segments === null) {
        return await miss(request, next, config, false);
      }
      const resolved = await resolveFile(config, segments);
      if (resolved === null) {
        return await miss(request, next, config);
      }
      const response = await serveFile(request, config, resolved);
      return response ?? await miss(request, next, config);
    };
  };
}
