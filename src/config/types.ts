import type { HypervisorConfig } from "../hypervisor/config.ts";

/**
 * Code-first Oxian 0.20 configuration.
 *
 * This contract deliberately contains only application and gateway behavior
 * owned by the 0.20 runtime. Worker definitions, bootstrap manifests,
 * credentials, provider compute specifications, and secrets belong to their
 * respective supervisor/provider/workload boundaries.
 */

export type ApplicationConfigInput = Readonly<{
  /**
   * Local filesystem path or file URL containing the application's route
   * modules. `loadConfig()` resolves relative paths against the config module.
   */
  routesRoot?: string;
  /**
   * Canonical URL mount path. Defaults to `/`.
   */
  basePath?: string;
  /**
   * Explicit local `.ts` module whose sole default export is an
   * `ApplicationFactory`.
   */
  factory?: string;
}>;

export type ApplicationConfig = Readonly<{
  routesRoot: string;
  basePath: string;
  factory?: string;
}>;

export type HttpListenerConfigInput = Readonly<{
  hostname?: string;
  port?: number;
}>;

export type HttpListenerConfig = Readonly<{
  hostname: string;
  port: number;
}>;

/**
 * The local worker path used by `createLocalRuntime()`.
 *
 * In-process delivery is the lightweight default. Worker WebSocket preserves
 * the full loopback protocol topology for transport integration testing.
 */
export type LocalWorkerTransport = "in-process" | "worker-websocket";

/**
 * Data-only subset of the CORS adapter options. Predicate functions are
 * intentionally application code, not configuration data.
 */
export type CorsConfigInput = Readonly<{
  origins: "*" | readonly string[];
  methods?: readonly string[];
  headers?: readonly string[];
  exposeHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}>;

export type CorsConfig = Readonly<{
  origins: "*" | readonly string[];
  methods: readonly string[];
  headers: readonly string[];
  exposeHeaders: readonly string[];
  credentials: boolean;
  maxAgeSeconds?: number;
}>;

/**
 * Data-only subset of the static adapter options. Dynamic cache-control and
 * content-type functions remain application composition concerns.
 */
export type StaticConfigInput = Readonly<{
  root: string;
  prefix?: string;
  index?: string | readonly string[] | false;
  cacheControl?: string;
  fallthrough?: boolean;
}>;

export type StaticConfig = Readonly<{
  root: string;
  prefix: string;
  index: readonly string[];
  cacheControl?: string;
  fallthrough: boolean;
}>;

/**
 * Deliberately small development-proxy declaration. Authentication and secret
 * material must not be embedded in the upstream URL.
 */
export type DevProxyConfigInput = Readonly<{
  upstream: string;
  prefix?: string;
  stripPrefix?: boolean;
  forwardHost?: boolean;
}>;

export type DevProxyConfig = Readonly<{
  upstream: string;
  prefix: string;
  stripPrefix: boolean;
  forwardHost: boolean;
}>;

export type EdgeConfigInput = Readonly<{
  cors?: CorsConfigInput;
  static?: StaticConfigInput;
  devProxy?: DevProxyConfigInput;
}>;

export type EdgeConfig = Readonly<{
  cors?: CorsConfig;
  static?: StaticConfig;
  devProxy?: DevProxyConfig;
}>;

export type GatewayConfigInput = Readonly<{
  listener?: HttpListenerConfigInput;
  workerTransport?: LocalWorkerTransport;
  hypervisor?: Partial<HypervisorConfig>;
  edge?: EdgeConfigInput;
}>;

export type GatewayConfig = Readonly<{
  listener: HttpListenerConfig;
  workerTransport: LocalWorkerTransport;
  hypervisor: HypervisorConfig;
  edge?: EdgeConfig;
}>;

export type OxianConfigInput = Readonly<{
  application?: ApplicationConfigInput;
  gateway?: GatewayConfigInput;
}>;

export type OxianConfig = Readonly<{
  application: ApplicationConfig;
  gateway: GatewayConfig;
}>;

export type LoadConfigSource = string | URL;
