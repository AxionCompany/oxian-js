/**
 * @fileoverview Pure functions for building worker spawn arguments.
 *
 * Extracted from hypervisor/lifecycle.ts so they can be unit-tested
 * without process spawning. Every function here is deterministic and
 * side-effect free (async only where resolver I/O is required).
 *
 * @module hypervisor_plugin/spawn_args
 */

import type { Resolver } from "../resolvers/types.ts";

// ---------------------------------------------------------------------------
// Types for inputs (kept minimal — no coupling to full config schema)
// ---------------------------------------------------------------------------

export type PermissionValue = boolean | string | string[];

export type PermissionMap = Record<string, PermissionValue>;

export interface OtelConfig {
  enabled?: boolean;
  serviceName?: string;
  endpoint?: string;
  protocol?: string;
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  propagators?: string;
  metricExportIntervalMs?: number;
}

export interface OtelProxyConfig {
  enabled?: boolean;
  port?: number;
}

// ---------------------------------------------------------------------------
// buildImportMap
// ---------------------------------------------------------------------------

/**
 * Merge the framework's own import map (from deno.json) with the host
 * host's import map, resolving relative specifiers via the resolver.
 *
 * Returns the merged `{ imports, scopes }` object ready to serialise.
 */
export async function buildImportMap(opts: {
  frameworkImports: Record<string, string>;
  frameworkScopes?: Record<string, Record<string, string>>;
  hostImports: Record<string, string>;
  hostScopes?: Record<string, Record<string, string>>;
  libSrcBaseHref: string;
  resolver: Resolver;
}): Promise<{
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}> {
  const mergedImports: Record<string, string> = {
    ...opts.frameworkImports,
    ...opts.hostImports,
  };

  // Ensure the internal "oxian-js/" bare specifier always points at the
  // library's own src directory so workers resolve correctly.
  if (mergedImports["oxian-js/"]) {
    mergedImports["oxian-js/"] = opts.libSrcBaseHref;
  }

  // Resolve relative (non-URL) specifiers through the resolver
  for (const [specifier, url] of Object.entries(mergedImports)) {
    const isUrl = url.split(":").length > 1;
    if (!isUrl) {
      mergedImports[specifier] = (await opts.resolver.resolve(url)).toString();
    }
  }

  return {
    imports: mergedImports,
    scopes: {
      ...(opts.frameworkScopes || {}),
      ...(opts.hostScopes || {}),
    },
  };
}

// ---------------------------------------------------------------------------
// buildUnstableFlags
// ---------------------------------------------------------------------------

/**
 * Turn the `unstable` array from deno.json into `--unstable-<flag>` args.
 */
export function buildUnstableFlags(
  unstable: string[] | undefined,
): string[] {
  if (!unstable?.length) return [];
  return unstable.map((flag) => `--unstable-${flag}`);
}

// ---------------------------------------------------------------------------
// buildPermissionArgs
// ---------------------------------------------------------------------------

/**
 * Build Deno permission CLI flags from global + per-service permission maps.
 *
 * Service permissions override global ones (last-write-wins per key).
 * If neither map is provided, returns `["-A"]` (allow-all).
 */
export function buildPermissionArgs(
  globalPerms: PermissionMap | undefined,
  servicePerms: PermissionMap | undefined,
): string[] {
  if (!globalPerms && !servicePerms) return ["-A"];

  const args: string[] = [];

  const pushPerms = (perms: PermissionMap) => {
    for (const [key, value] of Object.entries(perms)) {
      if (value !== false) {
        if (typeof value === "boolean" && value) {
          args.push(`--allow-${key}`);
        }
        if (typeof value === "string") {
          args.push(`--allow-${key}=${value}`);
        }
        if (typeof value === "object" && Array.isArray(value)) {
          args.push(`--allow-${key}=${value.join(",")}`);
        }
      } else {
        args.push(`--deny-${key}`);
      }
    }
  };

  if (globalPerms) pushPerms(globalPerms);
  if (servicePerms) pushPerms(servicePerms);

  return args;
}

// ---------------------------------------------------------------------------
// shouldReloadWorker
// ---------------------------------------------------------------------------

/**
 * Decide whether the worker should be spawned with `--reload`.
 *
 * Uses `invalidateCacheAt` (from the provider/service) compared to the
 * last load timestamp, falling back to `hotReload` from config.
 */
export function shouldReloadWorker(opts: {
  invalidateCacheAt?: string | number | Date;
  lastLoadMs: number;
  hotReload?: boolean;
}): boolean {
  if (opts.invalidateCacheAt !== undefined) {
    let invalidateAt = 0;
    if (opts.invalidateCacheAt instanceof Date) {
      invalidateAt = opts.invalidateCacheAt.getTime();
    } else if (typeof opts.invalidateCacheAt === "number") {
      invalidateAt = opts.invalidateCacheAt;
    } else if (typeof opts.invalidateCacheAt === "string") {
      const t = Date.parse(opts.invalidateCacheAt);
      if (!Number.isNaN(t)) invalidateAt = t;
    }
    return invalidateAt > opts.lastLoadMs;
  }
  return opts.hotReload === true;
}

// ---------------------------------------------------------------------------
// buildReloadArgs
// ---------------------------------------------------------------------------

/**
 * Build `--reload=<targets>` args for a worker spawn.
 *
 * Resolves relative targets through the resolver so the resulting URLs
 * are absolute.
 */
export async function buildReloadArgs(opts: {
  resolver: Resolver;
  serviceConfig?: string;
}): Promise<string[]> {
  const reloadTargets: string[] = [];
  try {
    const rootResolved = await opts.resolver.resolve("");
    if (rootResolved) reloadTargets.push(rootResolved.toString());
  } catch { /* ignore */ }
  if (opts.serviceConfig) reloadTargets.push(opts.serviceConfig);

  if (reloadTargets.length === 0) return [];

  const normalized: string[] = [];
  for (const t of reloadTargets) {
    const isUrl = t.split(":").length > 1;
    if (!isUrl) {
      try {
        normalized.push((await opts.resolver.resolve(t)).toString());
      } catch {
        normalized.push(t);
      }
    } else {
      normalized.push(t);
    }
  }
  return [`--reload=${normalized.join(",")}`];
}

// ---------------------------------------------------------------------------
// buildOtelEnv
// ---------------------------------------------------------------------------

/**
 * Build OpenTelemetry environment variables for a worker process.
 *
 * Returns an empty record when OTEL is not enabled.
 */
export function buildOtelEnv(opts: {
  otelConfig?: OtelConfig;
  otelProxy?: OtelProxyConfig;
  service: string;
}): Record<string, string> {
  const otelCfg = opts.otelConfig ?? {};
  const env: Record<string, string> = {};

  if (!otelCfg.enabled && !opts.otelProxy?.enabled) return env;

  env.OTEL_DENO = "true";

  if (otelCfg.serviceName) {
    env.OTEL_SERVICE_NAME = otelCfg.serviceName;
  }

  // Default to built-in collector or proxy if no endpoint is provided
  const builtInProxyPort = opts.otelProxy?.enabled
    ? (opts.otelProxy.port ?? 4318)
    : undefined;

  if (builtInProxyPort) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT =
      `http://127.0.0.1:${builtInProxyPort}`;
  } else if (otelCfg.endpoint) {
    env.OTEL_EXPORTER_OTLP_ENDPOINT = otelCfg.endpoint;
  }

  if (otelCfg.protocol) {
    env.OTEL_EXPORTER_OTLP_PROTOCOL = otelCfg.protocol;
  }

  // Headers — always attach service for built-in collector tagging
  const headerPairs: string[] = [];
  if (otelCfg.headers && Object.keys(otelCfg.headers).length) {
    for (const [k, v] of Object.entries(otelCfg.headers)) {
      headerPairs.push(`${k}=${v}`);
    }
  }
  headerPairs.push(`x-oxian-service=${opts.service}`);
  env.OTEL_EXPORTER_OTLP_HEADERS = headerPairs.join(",");

  // Resource attributes
  const baseAttrs: Record<string, string> = {
    ...(otelCfg.resourceAttributes || {}),
  };
  baseAttrs["oxian.service"] = opts.service;
  const attrs = Object.entries(baseAttrs).map(([k, v]) => `${k}=${v}`).join(
    ",",
  );
  if (attrs) env.OTEL_RESOURCE_ATTRIBUTES = attrs;

  if (otelCfg.propagators) {
    env.OTEL_PROPAGATORS = otelCfg.propagators;
  }
  if (typeof otelCfg.metricExportIntervalMs === "number") {
    env.OTEL_METRIC_EXPORT_INTERVAL = String(otelCfg.metricExportIntervalMs);
  }

  return env;
}
