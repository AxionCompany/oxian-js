import type { DevProxyAdapterOptions, FetchAdapter } from "./types.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type DevProxyConfiguration = Readonly<{
  upstream: URL;
  prefix: string;
  stripPrefix: boolean;
  forwardHost: boolean;
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
    throw new TypeError("dev proxy prefix must be an absolute URL path");
  }
  const segments = prefix.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("dev proxy prefix cannot contain traversal segments");
  }
  const normalized = prefix.replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
}

function createConfiguration(
  options: DevProxyAdapterOptions,
): DevProxyConfiguration {
  const upstream = new URL(
    options.upstream instanceof URL ? options.upstream.href : options.upstream,
  );
  if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
    throw new TypeError("dev proxy upstream must use http: or https:");
  }
  if (upstream.username !== "" || upstream.password !== "") {
    throw new TypeError("dev proxy upstream cannot contain credentials");
  }
  if (upstream.search !== "" || upstream.hash !== "") {
    throw new TypeError("dev proxy upstream cannot contain query or fragment");
  }
  return Object.freeze({
    upstream,
    prefix: normalizePrefix(options.prefix),
    stripPrefix: options.stripPrefix ?? false,
    forwardHost: options.forwardHost ?? false,
  });
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return pathname.startsWith("/");
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function targetUrl(requestUrl: URL, config: DevProxyConfiguration): URL {
  let forwardedPath = requestUrl.pathname;
  if (config.stripPrefix && config.prefix !== "/") {
    forwardedPath = requestUrl.pathname.slice(config.prefix.length) || "/";
  }

  const basePath = config.upstream.pathname === "/"
    ? ""
    : config.upstream.pathname.replace(/\/+$/, "");
  const suffix = forwardedPath.startsWith("/")
    ? forwardedPath
    : `/${forwardedPath}`;
  const target = new URL(config.upstream.href);
  target.pathname = `${basePath}${suffix}` || "/";
  target.search = requestUrl.search;
  return target;
}

function connectionHeaders(headers: Headers): ReadonlySet<string> {
  const names = new Set<string>();
  const connection = headers.get("connection");
  if (connection === null) return names;
  for (const token of connection.split(",")) {
    const name = token.trim().toLowerCase();
    if (name !== "") names.add(name);
  }
  return names;
}

function copyEndToEndHeaders(source: Headers): Headers {
  const target = new Headers();
  const connectionSpecific = connectionHeaders(source);
  const cookies = typeof source.getSetCookie === "function"
    ? source.getSetCookie()
    : [];
  let copiedCookies = false;

  for (const [name, value] of source) {
    const normalized = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionSpecific.has(normalized)
    ) {
      continue;
    }
    if (normalized === "set-cookie" && cookies.length > 0) {
      if (!copiedCookies) {
        for (const cookie of cookies) target.append("set-cookie", cookie);
        copiedCookies = true;
      }
      continue;
    }
    target.append(name, value);
  }
  if (!copiedCookies) {
    for (const cookie of cookies) target.append("set-cookie", cookie);
  }
  return target;
}

function proxyRequest(
  request: Request,
  target: URL,
  config: DevProxyConfiguration,
): Request {
  const headers = copyEndToEndHeaders(request.headers);
  headers.delete("host");
  if (config.forwardHost) {
    const original = request.headers.get("host") ?? new URL(request.url).host;
    headers.set("x-forwarded-host", original);
  }
  const method = request.method.toUpperCase();
  return new Request(target, {
    method: request.method,
    headers,
    body: method === "GET" || method === "HEAD" ? null : request.body,
    signal: request.signal,
    redirect: "manual",
  });
}

function proxyResponse(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: copyEndToEndHeaders(response.headers),
  });
}

/**
 * Creates an explicit development HTTP reverse proxy. It deliberately supports
 * only http(s); WebSocket upgrades belong to the worker transport, not this
 * convenience adapter.
 */
export function createDevProxyAdapter(
  options: DevProxyAdapterOptions,
): FetchAdapter {
  const config = createConfiguration(options);
  return (next) => {
    if (typeof next !== "function") {
      throw new TypeError("dev proxy adapter expects a Fetch handler");
    }
    return async (request) => {
      const incomingUrl = new URL(request.url);
      if (!matchesPrefix(incomingUrl.pathname, config.prefix)) {
        return await next(request);
      }

      try {
        const outgoing = proxyRequest(
          request,
          targetUrl(incomingUrl, config),
          config,
        );
        return proxyResponse(await fetch(outgoing));
      } catch (error) {
        if (request.signal.aborted) throw error;
        return new Response("Bad Gateway", { status: 502 });
      }
    };
  };
}
