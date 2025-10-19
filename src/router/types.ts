/**
 * @fileoverview Type definitions for the Oxian router system.
 * 
 * This module contains types for route matching, route records, and router
 * interfaces used by both eager and lazy routing strategies.
 * 
 * @module router/types
 */

/**
 * Represents a single route in the routing table.
 * 
 * A route record contains the URL pattern, parsed segments for matching,
 * and the file URL of the route handler module.
 */
export type RouteRecord = {
  /** URL pattern with parameters (e.g., "/users/:id") */
  pattern: string;
  /** Parsed segments for efficient matching */
  segments: Array<{ type: "static" | "param" | "catchall"; name?: string }>;
  /** File URL of the route handler module */
  fileUrl: URL;
};

/**
 * Result of matching a URL path against routes.
 * 
 * Returns the matched route and extracted parameters, or null if no match.
 */
export type RouteMatch =
  | { route: RouteRecord; params: Record<string, string> }
  | null;

/**
 * Router interface for matching URLs to routes.
 * 
 * Provides route table access and synchronous path matching.
 */
export type Router = {
  /** All registered routes */
  routes: RouteRecord[];
  /** Match a URL path to a route */
  match: (path: string) => RouteMatch;
};

/**
 * Function signature for listing directory contents.
 * 
 * Used by router to discover route files in the filesystem.
 */
export type ListDirFn = (dir: URL) => Promise<string[]>;

/**
 * Function signature for checking if a URL is a file.
 * 
 * Used by router to distinguish files from directories.
 */
export type StatFn = (url: URL) => Promise<{ isFile: boolean }>;

/**
 * Resolved router with metadata about the routing system.
 * 
 * Contains the router instance, loader manager, and information about
 * whether routes are loaded from remote sources.
 */
export type ResolvedRouter = {
  /** Router instance with routes and match function */
  router: {
    routes: Array<{ pattern: string }>;
    match: (
      path: string,
    ) => {
      route: { pattern: string; fileUrl: URL };
      params: Record<string, string>;
    } | null;
  } & {
    /** Optional async match for lazy routing */
    __asyncMatch?: (
      path: string,
    ) => Promise<
      {
        route: { pattern: string; fileUrl: URL };
        params: Record<string, string>;
      } | null
    >;
  };
  /** Loader manager for route modules */
  loaderManager: { getLoaders: () => unknown[] };
  /** Whether routes are loaded from remote sources */
  isRemote: boolean;
  /** Root URL of the routes directory */
  routesRootUrl?: URL;
};

