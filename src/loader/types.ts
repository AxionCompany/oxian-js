import type { Loader, LoaderMediaType } from "../core/types.ts";

export type { Loader, LoaderMediaType };

export function detectMediaType(filename: string): LoaderMediaType {
  if (filename.endsWith(".ts")) return "ts";
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (filename.endsWith(".json")) return "json";
  return "js";
} 