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
export type RouteParamValue = string | string[];

export type RouteSegment =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "catchall"; name: string };

export type RouteRecord = {
  /** URL pattern with parameters (e.g., "/users/:id") */
  pattern: string;
  /** Parsed segments for efficient matching */
  segments: RouteSegment[];
  /** File URL of the route handler module */
  fileUrl: URL;
};

/**
 * Result of matching a URL path against routes.
 *
 * Returns the matched route and extracted parameters, or null if no match.
 */
export type RouteMatch =
  | { route: RouteRecord; params: Record<string, RouteParamValue> }
  | null;

/**
 * Router interface for matching URLs to routes.
 *
 * Both eager and lazy routers implement this interface.
 * `match` is always async to support lazy on-demand filesystem discovery.
 */
export type Router = {
  /** All registered routes (empty for lazy routers until matched) */
  routes: RouteRecord[];
  /** Match a URL path to a route */
  match: (path: string) => Promise<RouteMatch>;
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
 * Contains the router instance and information about
 * whether routes are loaded from remote sources.
 */
export type ResolvedRouter = {
  /** Router instance */
  router: Router;
  /** Whether routes are loaded from remote sources */
  isRemote: boolean;
  /** Root URL of the routes directory */
  routesRootUrl?: URL;
};
