/**
 * Portable Oxian 0.21 package root.
 *
 * Runtime capabilities are available only through explicit subpaths so merely
 * importing Oxian never loads filesystem, process, listener, or Deno APIs.
 */
export * from "./core.ts";
