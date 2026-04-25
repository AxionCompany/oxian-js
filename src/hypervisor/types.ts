/**
 * @fileoverview Type definitions for Oxian hypervisor system.
 *
 * @module hypervisor/types
 */

import type { EffectiveConfig } from "../config/index.ts";
import type { Resolver } from "../resolvers/types.ts";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Permission set for Deno worker processes. */
export type PermissionSet = {
  read?: boolean | string[];
  write?: boolean | string[];
  import?: boolean | string[];
  env?: boolean | string[];
  net?: boolean | string[];
  run?: boolean | string[];
  ffi?: boolean | string[];
  sys?: boolean | string[];
  all?: boolean;
};

/** Materialization options for remote sources. */
export type MaterializeOpts = {
  mode?: "auto" | "always" | "never";
  dir?: string;
  refresh?: boolean;
};

/**
 * Complete service definition — returned by the provider function.
 *
 * Contains everything the hypervisor needs to route a request and
 * spawn a worker: identity, spawn config, and lifecycle hints.
 */
export interface ServiceDefinition {
  /** Service identifier — used as cache key for running processes. */
  service: string;
  /** Pre-known target URL — proxy directly, skip spawn. */
  target?: string;
  /** Source URL or path for the service code. */
  source?: string;
  /** Configuration URL or path for the service. */
  config?: string;
  /** Source-specific auth tokens, keyed by scheme (e.g., `{ github: "ghp_xxx" }`). */
  auth?: Record<string, string>;
  /** Deno permission flags for the worker process. */
  permissions?: PermissionSet;
  /** Materialization options for remote sources. */
  materialize?: boolean | MaterializeOpts;
  /** Environment variables for the worker process. */
  env?: Record<string, string>;
  /** Run the service in an isolated directory sandbox. */
  isolated?: boolean;
  /** Path prefix to strip before proxying to the worker. */
  stripPathPrefix?: string;
  /** Timestamp — if newer than last spawn, triggers a worker restart. */
  invalidateCacheAt?: string | number | Date;
  /** Idle time-to-live — worker is stopped after this many ms without traffic. */
  idleTtlMs?: number;
  /** Path to deno.json config for the worker process. */
  denoConfig?: string;
}

// ---------------------------------------------------------------------------
// Worker handle
// ---------------------------------------------------------------------------

/**
 * Handle for managing a worker process.
 *
 * Tracks the worker's port and process handle for lifecycle management.
 */
export type WorkerHandle = {
  port: number;
  proc: Deno.ChildProcess;
};

// ---------------------------------------------------------------------------
// Spawn result
// ---------------------------------------------------------------------------

/**
 * Result of a plugin spawn operation.
 *
 * Contains the target URL to proxy to, an opaque handle for stopping
 * the worker, and an optional owner ID for distributed coordination.
 */
export interface SpawnResult {
  /** URL to proxy requests to (e.g. "http://127.0.0.1:9101"). */
  target: string;
  /** Opaque handle — passed back to plugin.stop(). Only meaningful to the plugin instance that created it. */
  handle?: unknown;
  /** Instance ID that owns this spawn (for distributed coordination). */
  owner?: string;
}

// ---------------------------------------------------------------------------
// Spawn spec (internal to plugins)
// ---------------------------------------------------------------------------

/**
 * Describes how to spawn a worker process.
 *
 * This is an internal data object used by plugins — not part of the
 * public HypervisorPlugin interface. Plugins use it internally to
 * build the arguments for `Deno.Command`.
 */
export interface SpawnSpec {
  /** Absolute path to the executable (typically `Deno.execPath()`). */
  execPath: string;
  /** Full argument list (deno args + script args). */
  args: string[];
  /** Environment variables for the child process. */
  env: Record<string, string>;
  /** Working directory for the child process. */
  cwd: string;
}

// ---------------------------------------------------------------------------
// Plugin interface — makes the hypervisor application-agnostic
// ---------------------------------------------------------------------------

/**
 * Context passed to every plugin method.
 *
 * Contains the resolved config, resolver, and CLI arguments that the
 * hypervisor was started with.
 */
export interface PluginContext {
  config: EffectiveConfig;
  resolver: Resolver;
  denoOptions: string[];
  scriptArgs: string[];
}

/**
 * Plugin interface that makes the hypervisor application-agnostic.
 *
 * The hypervisor handles generic concerns (proxy, queue, idle lifecycle)
 * while the plugin provides lifecycle primitives: spawn, stop, and
 * readiness checking.
 *
 * The default implementation (`OxianPlugin`) spawns local Deno
 * subprocesses, but custom plugins can target external platforms
 * (Cloud Run, K8s, etc.).
 */
export interface HypervisorPlugin {
  /** One-time setup before any workers spawn. */
  init?(ctx: PluginContext): Promise<void>;

  /**
   * Spawn a service worker and return its target URL.
   *
   * This is the core plugin method — it determines *how* a worker
   * is created and where it lives. The returned `SpawnResult` tells
   * the hypervisor where to proxy traffic and provides an opaque
   * handle for later stop/restart.
   */
  spawn(
    service: ServiceDefinition,
    ctx: PluginContext,
    opts: { port: number; idx: number },
  ): Promise<SpawnResult>;

  /**
   * Stop a previously spawned worker.
   *
   * Receives the opaque handle from `SpawnResult.handle`.
   */
  stop(handle: unknown): Promise<void>;

  /**
   * Check if a target is ready to accept traffic.
   *
   * Called after spawn to verify readiness.
   */
  checkReady(
    target: string,
    opts: { timeoutMs: number },
  ): Promise<boolean>;

  /**
   * Transform headers before proxying a request to a worker.
   *
   * Optional — called on every proxied request.
   */
  transformProxyHeaders?(
    headers: Headers,
    req: Request,
    service: string,
  ): void;
}

// ---------------------------------------------------------------------------
// Store interface — pluggable state for distributed hypervisor
// ---------------------------------------------------------------------------

/**
 * Pluggable state store for hypervisor coordination.
 *
 * All hypervisor shared state (pools, locks, queues, counters) goes
 * through this interface. The default `MemoryStore` wraps in-memory
 * Maps for zero-overhead single-instance use. Custom implementations
 * (e.g. Redis) enable distributed multi-instance deployments.
 */
export interface HypervisorStore {
  // ── Key-value ───────────────────────────────────────────────────────
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;

  // ── Counters ────────────────────────────────────────────────────────
  increment(key: string): Promise<number>;
  decrement(key: string): Promise<number>;

  // ── Distributed locks ───────────────────────────────────────────────
  acquire(key: string, ttlMs: number): Promise<boolean>;
  release(key: string): Promise<void>;

  // ── Request-response queue ──────────────────────────────────────────
  /** Enqueue an item and return a correlation ID. */
  enqueue<T>(queue: string, item: T): Promise<string>;
  /** Drain all pending items from a queue. */
  drain<T>(queue: string): Promise<Array<{ id: string; item: T }>>;
  /** Block until a correlated response is available. */
  waitFor<T>(id: string, timeoutMs?: number): Promise<T>;
  /** Resolve a pending waitFor with a value. */
  resolve<T>(id: string, value: T): Promise<void>;
}
