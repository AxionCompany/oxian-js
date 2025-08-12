export type OxianConfig = {
  root?: string;
  basePath?: string;
  loaders?: {
    local?: { enabled?: boolean };
    github?: { enabled?: boolean; tokenEnv?: string; cacheTtlSec?: number };
  };
  runtime?: {
    hotReload?: boolean;
    watchGlobs?: string[];
    // New: dependency injection from config
    dependencies?: {
      initial?: Record<string, unknown>;
      bootstrapModule?: string; // path to a module exporting default or createDependencies(): Promise<Record<string, unknown>> | Record
      merge?: "shallow" | "deep" | "replace"; // currently shallow
      readonly?: string[]; // keys to freeze
    };
    // New: hypervisor (process/thread-based proxy)
    hv?: {
      enabled?: boolean;
      workers?: number | "auto";
      strategy?: "round_robin" | "least_busy" | "sticky";
      stickyHeader?: string; // used when strategy = sticky
      workerBasePort?: number; // default 9100
      proxy?: { timeoutMs?: number; passRequestId?: boolean };
      health?: { path?: string; intervalMs?: number; timeoutMs?: number };
      autoscale?: {
        enabled?: boolean;
        min?: number;
        max?: number;
        targetInflightPerWorker?: number; // scale up if avg inflight/worker exceeds
        maxAvgLatencyMs?: number; // optional latency trigger
        scaleUpCooldownMs?: number;
        scaleDownCooldownMs?: number;
        idleTtlMs?: number; // time idle before scale down
      };
    };
  };
  // New: permissions declaration (enforced by hypervisor or future runners)
  permissions?: {
    net?: boolean | string[];
    read?: boolean | string[];
    write?: boolean | string[];
    env?: boolean | string[];
    ffi?: boolean;
    hrtime?: boolean;
    sys?: boolean | string[];
  };
  server?: {
    port?: number;
  };
  routing?: {
    trailingSlash?: "always" | "never" | "preserve";
    routesDir?: string; // default: "routes"
    discovery?: "eager" | "lazy"; // default: eager
  };
  security?: {
    cors?: { allowedOrigins: string[]; allowedHeaders?: string[]; methods?: string[] };
    defaultHeaders?: Record<string, string>;
    scrubHeaders?: string[];
  };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    requestIdHeader?: string;
    deprecations?: boolean; // default true
  };
  compatibility?: {
    handlerMode?: "default" | "this" | "factory";
    allowShared?: boolean; // default true when undefined
  };
};

export type EffectiveConfig = Required<Pick<OxianConfig, "root" | "basePath" | "server" | "logging">> & OxianConfig; 