import type { EdgeConfig } from "../config/types.ts";
import {
  createCorsAdapter,
  createDevProxyAdapter,
  createStaticAdapter,
  type FetchHandler,
} from "../edge/index.ts";
import type { LocalRuntimeMode } from "./types.ts";

function matchesMount(pathname: string, mount: string): boolean {
  if (mount === "/") return pathname.startsWith("/");
  return pathname === mount || pathname.startsWith(`${mount}/`);
}

function isStrictParentMount(parent: string, child: string): boolean {
  return parent !== child && matchesMount(child, parent);
}

function preserveMoreSpecificApplicationMount(
  adapted: FetchHandler,
  next: FetchHandler,
  adapterMount: string,
  applicationBasePath: string,
): FetchHandler {
  if (!isStrictParentMount(adapterMount, applicationBasePath)) return adapted;
  return async (request) =>
    matchesMount(new URL(request.url).pathname, applicationBasePath)
      ? await next(request)
      : await adapted(request);
}

/**
 * Applies declarative edge behavior at the HTTP boundary. The application and
 * worker protocol stay unaware of static files, CORS, and development proxies.
 */
export function composeConfiguredEdge(
  handler: FetchHandler,
  edge: EdgeConfig | undefined,
  mode: LocalRuntimeMode,
  applicationBasePath = "/",
): FetchHandler {
  const mountedApplication: FetchHandler = async (request) =>
    matchesMount(new URL(request.url).pathname, applicationBasePath)
      ? await handler(request)
      : new Response("Not Found", { status: 404 });
  let composed = mountedApplication;

  if (mode === "dev" && edge?.devProxy !== undefined) {
    const next = composed;
    const adapted = createDevProxyAdapter({
      upstream: edge.devProxy.upstream,
      prefix: edge.devProxy.prefix,
      stripPrefix: edge.devProxy.stripPrefix,
      forwardHost: edge.devProxy.forwardHost,
    })(next);
    composed = preserveMoreSpecificApplicationMount(
      adapted,
      next,
      edge.devProxy.prefix,
      applicationBasePath,
    );
  }

  if (edge?.static !== undefined) {
    const next = composed;
    const adapted = createStaticAdapter({
      root: edge.static.root,
      prefix: edge.static.prefix,
      index: edge.static.index,
      fallback: edge.static.fallback,
      cacheControl: edge.static.cacheControl,
      fallthrough: edge.static.fallthrough,
    })(next);
    composed = preserveMoreSpecificApplicationMount(
      adapted,
      next,
      edge.static.prefix,
      applicationBasePath,
    );
  }

  if (edge?.cors !== undefined) {
    composed = createCorsAdapter({
      origins: edge.cors.origins,
      methods: edge.cors.methods,
      headers: edge.cors.headers,
      exposeHeaders: edge.cors.exposeHeaders,
      credentials: edge.cors.credentials,
      maxAgeSeconds: edge.cors.maxAgeSeconds,
    })(composed);
  }

  return Object.freeze(composed);
}
