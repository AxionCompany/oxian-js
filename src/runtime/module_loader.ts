/**
 * @fileoverview Module loading and caching utilities for the Oxian runtime.
 *
 * This module provides functionality for loading and caching route modules,
 * handling both local file-based modules and remote modules. It includes
 * cache management, modification time tracking, and HTTP method handler
 * resolution for route modules.
 *
 * @module runtime/module_loader
 */

import type { Resolver } from "../resolvers/types.ts";

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

const moduleCache = new Map<string, LoadedModule>();

/**
 * Clears the internal module cache.
 *
 * This function removes all cached modules from memory, forcing subsequent
 * loads to re-import and re-evaluate modules. This is primarily useful
 * during development or hot-reloading scenarios.
 *
 * @example
 * ```typescript
 * // Clear cache before hot reload
 * clearModuleCache();
 * ```
 */
export function clearModuleCache() {
  moduleCache.clear();
}

/**
 * Loads a route module from a file URL with caching support.
 *
 * This function dynamically imports a route module, handling both local file-based
 * modules and remote modules. For local files, it implements cache invalidation
 * based on modification time. For remote modules, it uses the loader system.
 *
 * @param fileUrl - The URL of the module to load
 * @param projectRoot - The project root directory (defaults to current working directory)
 * @returns Promise that resolves to the loaded module
 *
 * @example
 * ```typescript
 * const routeModule = await loadRouteModule(
 *   new URL("file:///app/routes/users/[id].ts"),
 *   "/app"
 * );
 *
 * // Access exported handlers
 * const getHandler = routeModule.GET;
 * const postHandler = routeModule.POST;
 * ```
 */
export async function loadRouteModule(
  fileUrl: URL,
  resolver: Resolver,
): Promise<LoadedModule> {
  const key = fileUrl.toString();
  if (moduleCache.has(key)) return moduleCache.get(key) as LoadedModule;
  const mod = await resolver.import(fileUrl);
  moduleCache.set(key, mod);
  return mod;
}

/**
 * Resolves the appropriate handler function for an HTTP method from a module.
 *
 * This function looks for exported handler functions in a route module, first
 * checking for method-specific exports (GET, POST, etc.) and falling back to
 * a default export if no method-specific handler is found.
 *
 * @param mod - The loaded module to search for handlers
 * @param method - The HTTP method to find a handler for
 * @returns The handler function if found, otherwise undefined
 *
 * @example
 * ```typescript
 * const module = await loadRouteModule(routeUrl);
 * const handler = getHandlerExport(module, "GET");
 *
 * if (typeof handler === "function") {
 *   const result = await handler(data, context);
 * }
 * ```
 */
export function getHandlerExport(mod: LoadedModule, method: string): unknown {
  const upper = method.toUpperCase();
  if (upper in mod) return (mod as Record<string, unknown>)[upper];
  if ("default" in mod) return (mod as Record<string, unknown>)["default"];
  return undefined;
}
