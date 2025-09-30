/**
 * @fileoverview Type definitions for Oxian framework configuration.
 * 
 * This module exports TypeScript type definitions that define the complete
 * configuration schema for Oxian applications. It includes settings for
 * server configuration, routing, security, logging, runtime behavior,
 * hypervisor settings, and compatibility options.
 * 
 * @module config/types
 */

/**
 * Complete configuration schema for Oxian applications.
 * 
 * This type defines all available configuration options for an Oxian application,
 * including server settings, routing behavior, security policies, logging configuration,
 * runtime options, hypervisor settings, and compatibility modes.
 * 
 * @example
 * ```typescript
 * const config: OxianConfig = {
 *   server: { port: 8080 },
 *   routing: { routesDir: "routes", trailingSlash: "never" },
 *   security: {
 *     cors: { allowedOrigins: ["*"] },
 *     defaultHeaders: { "x-powered-by": "Oxian" }
 *   },
 *   logging: { level: "info" }
 * };
 * ```
 */
export type OxianConfig = {
  root?: string;
  basePath?: string;
  loaders?: {
    local?: { enabled?: boolean };
    github?: { enabled?: boolean; tokenEnv?: string; token?: string; cacheTtlSec?: number };
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
    // Hypervisor (process/thread-based proxy)
    hv?: {
      enabled?: boolean;
      workers?: number | "auto";
      strategy?: "round_robin" | "least_busy" | "sticky";
      stickyHeader?: string; // used when strategy = sticky
      workerBasePort?: number; // default 9100
      proxy?: { timeoutMs?: number; passRequestId?: boolean };
      // Optional bounded in-memory queue to buffer requests while workers start/swap
      // Defaults: enabled=true, maxItems=100, maxBodyBytes=1048576 (1MB), maxWaitMs=2000
      queue?: {
        enabled?: boolean;
        maxItems?: number;
        maxBodyBytes?: number;
        maxWaitMs?: number;
      };
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
      // New in redesign: host deno config to forward to workers (path or URL)
      denoConfig?: string;
      // Request lifecycle timeouts (proxy-level)
      timeouts?: { connectMs?: number; headersMs?: number; idleMs?: number; totalMs?: number };
      // Materialize settings for remote sources (global default)
      materialize?: boolean | { mode?: "auto" | "always" | "never"; dir?: string; refresh?: boolean };
      // Web dev/prod integration
      web?: {
        devProxyTarget?: string; // e.g., http://localhost:5173
        staticDir?: string;      // e.g., "dist"
        staticCacheControl?: string; // e.g., "public, max-age=31536000, immutable"
      };
      // Config-only multi-project support
      projects?: Record<string, {
        source?: string;
        // Optional path or URL to a project-specific config file (e.g., oxian.config.ts|js|json)
        config?: string;
        // Optional GitHub token override for this project (enables per-worker tokens)
        githubToken?: string;
        routing?: { basePath?: string };
        // Per-project web settings overlaying global hv.web
        web?: {
          devProxyTarget?: string;
          staticDir?: string;
          staticCacheControl?: string;
        };
        // Per-project materialization settings
        materialize?: boolean | { mode?: "auto" | "always" | "never"; dir?: string; refresh?: boolean };
        // Idle timeout: stop worker if no activity for this duration in ms
        idleTtlMs?: number;
        worker?: { kind?: "process" | "thread"; pool?: { min?: number; max?: number } };
        strategy?: "round_robin" | "least_busy" | "sticky";
        stickyHeader?: string;
        timeouts?: { connectMs?: number; headersMs?: number; idleMs?: number; totalMs?: number };
        health?: { path?: string; intervalMs?: number; timeoutMs?: number };
        permissions?: {
          read?: boolean | string[];
          write?: boolean | string[];
          import?: boolean | string[];
          env?: boolean | string[];
          net?: boolean | string[];
          ffi?: boolean | string[];
          run?: boolean | string[];
          sys?: boolean | string[];
        };
        denoConfig?: string; // per-project override
        dependencies?: { initial?: Record<string, unknown> };
      }>;
      // Built-in minimal OTLP HTTP collector (http/protobuf or http/json)
      otelCollector?: {
        enabled?: boolean;
        port?: number; // default 4318
        pathPrefix?: string; // default "/v1"
        // Called for each export request; body is raw bytes (opaque to oxian)
        onExport?: (input: {
          kind: "traces" | "metrics" | "logs";
          headers: Record<string, string>;
          body: Uint8Array;
          contentType: string;
          project?: string;
        }) => void | Promise<void>;
      };
      // Single provider function (optional). When provided:
      // - Called with { req } to choose a project and per-request/project overrides.
      provider?: (
        input: { req: Request }
      ) => Promise<{
        project: string;
        source?: string;
        config?: string;
        env?: Record<string, string>;
        githubToken?: string;
        stripPathPrefix?: string;
        permissions?: {
          net?: boolean | string[];
          read?: boolean | string[];
          write?: boolean | string[];
          env?: boolean | string[];
          import?: boolean | string[];
          ffi?: boolean | string[];
          run?: boolean | string[];
          sys?: boolean | string[];
        };
        materialize?: boolean | { mode?: "auto" | "always" | "never"; dir?: string; refresh?: boolean };
      }> | {
        project: string;
        source?: string;
        config?: string;
        env?: Record<string, string>;
        githubToken?: string;
        stripPathPrefix?: string;
        permissions?: {
          net?: boolean | string[];
          read?: boolean | string[];
          write?: boolean | string[];
          env?: boolean | string[];
          import?: boolean | string[];
          ffi?: boolean | string[];
          run?: boolean | string[];
          sys?: boolean | string[];
        };
        materialize?: boolean | { mode?: "auto" | "always" | "never"; dir?: string; refresh?: boolean };
      };
      // Declarative selection rules
      select?: Array<
        | { default: true; project: string }
        | {
          project: string;
          when: {
            pathPrefix?: string;
            hostEquals?: string;
            hostPrefix?: string;
            hostSuffix?: string;
            method?: string;
            header?: Record<string, string | RegExp>;
          };
        }
      >;
    };
  };
  // Permissions declaration (enforced by hypervisor or future runners)
  permissions?: {
    net?: boolean | string[];
    read?: boolean | string[];
    write?: boolean | string[];
    env?: boolean | string[];
    ffi?: boolean | string[];
    import?: boolean | string[];
    run?: boolean | string[];
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
    cors?: {
      allowedOrigins: string[];
      allowedHeaders?: string[];
      methods?: string[];
      allowCredentials?: boolean;
      exposeHeaders?: string[];
      maxAge?: number;
    };
    defaultHeaders?: Record<string, string>;
    scrubHeaders?: string[];
  };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    requestIdHeader?: string;
    deprecations?: boolean; // default true
    performance?: boolean; // enable perf timing logs
    // Optional structured log event callback; invoked for server and hypervisor events
    onEvent?: (event: { level: "debug" | "info" | "warn" | "error"; time: string; source: string; project: string; payload: Record<string, unknown> }) => void;
    // Control console output; true by default
    console?: boolean;
    // Sampling for callbacks (0..1). Default 1 (no sampling)
    sampleRate?: number;
    // Additional headers to redact in request logs
    redactHeaders?: string[];
    // When true, server consolidates a single end-of-request log with req/res and stdout
    consolidateServerRequestLog?: boolean;
    // When true, server attempts to capture console.* during request and include in stdout (best-effort)
    captureConsole?: boolean;
    // OpenTelemetry integration for workers and server
    otel?: {
      enabled?: boolean;
      serviceName?: string;
      endpoint?: string; // e.g., http://localhost:4318
      protocol?: "http/protobuf" | "http/json";
      headers?: Record<string, string>; // exporter headers
      resourceAttributes?: Record<string, string>; // additional OTEL_RESOURCE_ATTRIBUTES
      propagators?: string; // e.g., "tracecontext,baggage"
      metricExportIntervalMs?: number; // OTEL_METRIC_EXPORT_INTERVAL
      // Optional user hooks for custom spans/metrics
      hooks?: {
        onInit?: (input: { tracer?: unknown; meter?: unknown }) => unknown | Promise<unknown>;
        onRequestStart?: (input: { tracer?: unknown; meter?: unknown; span?: unknown; requestId: string; method: string; url: string; project: string; state?: unknown }) => void | Promise<void>;
        onRequestEnd?: (input: { tracer?: unknown; meter?: unknown; span?: unknown; requestId: string; method: string; url: string; project: string; status: number; durationMs: number; state?: unknown }) => void | Promise<void>;
      };
    };
  };
  compatibility?: {
    handlerMode?: "default" | "this" | "factory";
    allowShared?: boolean; // default true when undefined
    middlewareMode?: "default" | "this" | "factory" | "assign"; // defaults to 'default' when undefined
    useMiddlewareRequest?: boolean; // default false when undefined
  };
  // Top-level Web dev/prod integration for worker context (preferred over runtime.hv.web)
  web?: {
    devProxyTarget?: string; // e.g., http://localhost:5173
    staticDir?: string;      // e.g., "dist"
    staticCacheControl?: string; // e.g., "public, max-age=31536000, immutable"
  };
  // Optional pre-run commands executed after materialization (in materialized root)
  preRun?: Array<string | { cmd: string; cwd?: string; env?: Record<string, string> }>;
};

/**
 * Effective configuration type with required fields.
 * 
 * This type represents the final configuration after all defaults have been applied.
 * It ensures that certain critical configuration fields are always present by making
 * them required, while keeping all other OxianConfig fields optional.
 * 
 * @example
 * ```typescript
 * // After loading and applying defaults
 * const effectiveConfig: EffectiveConfig = {
 *   root: "/app",
 *   basePath: "/",
 *   server: { port: 8080 },
 *   logging: { level: "info" },
 *   // ... other optional fields
 * };
 * ```
 */
export type EffectiveConfig = Required<Pick<OxianConfig, "root" | "basePath" | "server" | "logging">> & OxianConfig; 