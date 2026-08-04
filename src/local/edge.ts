import type { EdgeConfig } from "../config/types.ts";
import {
  createCorsAdapter,
  createDevProxyAdapter,
  createStaticAdapter,
  type FetchHandler,
} from "../edge/index.ts";
import type { LocalRuntimeMode } from "./types.ts";

/**
 * Applies declarative edge behavior at the HTTP boundary. The application and
 * worker protocol stay unaware of static files, CORS, and development proxies.
 */
export function composeConfiguredEdge(
  handler: FetchHandler,
  edge: EdgeConfig | undefined,
  mode: LocalRuntimeMode,
): FetchHandler {
  let composed = handler;

  if (mode === "dev" && edge?.devProxy !== undefined) {
    composed = createDevProxyAdapter({
      upstream: edge.devProxy.upstream,
      prefix: edge.devProxy.prefix,
      stripPrefix: edge.devProxy.stripPrefix,
      forwardHost: edge.devProxy.forwardHost,
    })(composed);
  }

  if (edge?.static !== undefined) {
    composed = createStaticAdapter({
      root: edge.static.root,
      prefix: edge.static.prefix,
      index: edge.static.index,
      cacheControl: edge.static.cacheControl,
      fallthrough: edge.static.fallthrough,
    })(composed);
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
