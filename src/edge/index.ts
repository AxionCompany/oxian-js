export { createCorsAdapter } from "./cors.ts";
export { createDevProxyAdapter } from "./dev_proxy.ts";
export { createStaticAdapter } from "./static.ts";
export type {
  CorsAdapterOptions,
  CorsOriginPolicy,
  CorsOriginPredicate,
  DevProxyAdapterOptions,
  FetchAdapter,
  FetchHandler,
  StaticAdapterOptions,
  StaticCacheControl,
  StaticContentType,
} from "./types.ts";
