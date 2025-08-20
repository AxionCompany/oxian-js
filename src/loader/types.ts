/**
 * @fileoverview Loader type definitions and utilities for the Oxian framework.
 * 
 * This module provides type definitions and utilities for Oxian's module
 * loading system. It re-exports core loader types and provides utility
 * functions for working with different media types.
 * 
 * @module loader/types
 */

import type { Loader, LoaderMediaType } from "../core/types.ts";

export type { Loader, LoaderMediaType };

/**
 * Detects the media type of a file based on its filename extension.
 * 
 * This function examines the file extension to determine the appropriate
 * media type for module loading. It supports TypeScript, JavaScript,
 * JSX, TSX, and JSON files.
 * 
 * @param filename - The filename to analyze
 * @returns The detected media type
 * 
 * @example
 * ```typescript
 * detectMediaType("routes/user.ts");     // returns "ts"
 * detectMediaType("component.tsx");      // returns "tsx"
 * detectMediaType("config.json");        // returns "json"
 * detectMediaType("script.js");          // returns "js"
 * detectMediaType("unknown.txt");        // returns "js" (default)
 * ```
 */
export function detectMediaType(filename: string): LoaderMediaType {
  if (filename.endsWith(".ts")) return "ts";
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (filename.endsWith(".json")) return "json";
  return "js";
} 