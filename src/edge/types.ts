export type FetchHandler = (
  request: Request,
) => Response | Promise<Response>;

export type FetchAdapter = (
  next: FetchHandler,
) => FetchHandler;

export type CorsOriginPredicate = (
  origin: string,
  request: Request,
) => boolean | Promise<boolean>;

export type CorsOriginPolicy =
  | "*"
  | readonly string[]
  | CorsOriginPredicate;

export type CorsAdapterOptions = Readonly<{
  /**
   * Origins are denied unless explicitly listed, accepted by the predicate, or
   * the wildcard policy is selected.
   */
  origins: CorsOriginPolicy;
  methods?: readonly string[];
  headers?: readonly string[];
  exposeHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}>;

export type StaticContentType = (
  path: string,
  info: Deno.FileInfo,
) => string | undefined;

export type StaticCacheControl = (
  path: string,
  info: Deno.FileInfo,
) => string | undefined;

export type StaticAdapterOptions = Readonly<{
  root: string | URL;
  prefix?: string;
  index?: string | readonly string[] | false;
  cacheControl?: string | StaticCacheControl;
  contentType?: StaticContentType;
  /**
   * Delegate misses to the wrapped handler. Defaults to true.
   */
  fallthrough?: boolean;
}>;

export type DevProxyAdapterOptions = Readonly<{
  upstream: string | URL;
  prefix?: string;
  stripPrefix?: boolean;
  /**
   * Forward the original authority as X-Forwarded-Host. Native fetch always
   * supplies the upstream Host header.
   */
  forwardHost?: boolean;
}>;
