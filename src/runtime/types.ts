/**
 * @fileoverview Type definitions for the Oxian runtime system.
 * 
 * This module contains types for module loading, pipeline discovery,
 * and other runtime-related functionality.
 * 
 * @module runtime/types
 */

/**
 * Represents a loaded JavaScript/TypeScript module.
 *
 * This type represents any module that has been dynamically imported,
 * containing all the exported symbols from that module as key-value pairs.
 *
 * @example
 * ```typescript
 * const module: LoadedModule = {
 *   GET: (data, context) => { ... },
 *   POST: (data, context) => { ... },
 *   default: (data, context) => { ... }
 * };
 * ```
 */
export type LoadedModule = Record<string, unknown>;

/**
 * Collection of pipeline files discovered for a route.
 * 
 * Pipeline files include dependencies, middleware, interceptors, and shared modules
 * that are loaded in hierarchical order from the routes directory.
 */
export type PipelineFiles = {
  /** Dependency injection files (dependencies.ts/js) */
  dependencyFiles: URL[];
  /** Middleware files (middleware.ts/js) */
  middlewareFiles: URL[];
  /** Interceptor files (interceptors.ts/js) */
  interceptorFiles: URL[];
  /** Shared utility files (shared.ts/js) */
  sharedFiles: URL[];
};

