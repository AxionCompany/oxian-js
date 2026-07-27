/**
 * Normalizes an application mount path.
 *
 * The deliberately conservative canonical syntax is `/` or one or more
 * slash-separated ASCII segments containing only letters, digits, `.`, `_`,
 * `~`, or `-`. Empty, `.` and `..` segments, percent escapes, duplicate
 * separators, and a trailing slash are rejected. Keeping one lexical form for
 * every mount makes segment-boundary matching unambiguous.
 */
export function normalizeApplicationBasePath(
  value: unknown,
  path = "application.basePath",
): string {
  const basePath = value === undefined ? "/" : value;
  if (typeof basePath !== "string") {
    throw new TypeError(`${path} must be a canonical absolute URL path`);
  }
  if (basePath === "/") return basePath;
  if (
    !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath) ||
    basePath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(
      `${path} must be "/" or a canonical absolute path of unescaped ASCII segments without a trailing slash`,
    );
  }
  return basePath;
}

export function stripApplicationBasePath(
  pathname: string,
  basePath: string,
): string | null {
  if (basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : null;
}
