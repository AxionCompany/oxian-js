import type { RouteRecord, RouteSegment } from "./types.ts";

const ROUTE_FILE_EXTENSION = /\.(tsx?|jsx?)$/;
const DYNAMIC_SEGMENT_PATTERN = /^\[([\w-]+)\]$/;
const CATCHALL_SEGMENT_PATTERN = /^\[\.\.\.([\w-]+)\]$/;

export function isRouteModuleFile(name: string): boolean {
  return ROUTE_FILE_EXTENSION.test(name);
}

export function stripRouteModuleExtension(name: string): string {
  return name.replace(ROUTE_FILE_EXTENSION, "");
}

export function parseRouteSegmentToken(token: string): RouteSegment {
  const catchAll = token.match(CATCHALL_SEGMENT_PATTERN);
  if (catchAll) return { type: "catchall", name: catchAll[1] };

  const dynamic = token.match(DYNAMIC_SEGMENT_PATTERN);
  if (dynamic) return { type: "param", name: dynamic[1] };

  return { type: "static", value: token };
}

export function isCatchAllSegmentToken(token: string): boolean {
  return CATCHALL_SEGMENT_PATTERN.test(token);
}

export function isParamSegmentToken(token: string): boolean {
  return DYNAMIC_SEGMENT_PATTERN.test(token);
}

export function createRouteRecord(
  routeParts: string[],
  fileUrl: URL,
  opts?: { trailingSlash?: boolean },
): RouteRecord {
  const segments = routeParts.map(parseRouteSegmentToken);
  const segmentPath = segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return `:${segment.name}`;
    return "*";
  }).join("/");

  const trailingSlash = opts?.trailingSlash && routeParts.length > 0 ? "/" : "";
  const pattern = segmentPath ? `/${segmentPath}${trailingSlash}` : "/";

  return { pattern, segments, fileUrl };
}

export function createRouteRecordFromRelativeFile(
  relPath: string,
  fileUrl: URL,
): RouteRecord | null {
  if (!isRouteModuleFile(relPath)) return null;

  const stripped = stripRouteModuleExtension(relPath);
  const parts = stripped.split("/").filter(Boolean);
  const trailingSlash = parts[parts.length - 1] === "index";
  const routeParts = trailingSlash ? parts.slice(0, -1) : parts;

  return createRouteRecord(routeParts, fileUrl, { trailingSlash });
}
