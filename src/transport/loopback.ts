/**
 * Whether a URL hostname stays on the machine: `localhost`, any `*.localhost`
 * name (browsers resolve these to loopback, RFC 6761), 127.0.0.1 and ::1.
 * A trailing dot and letter case are ignored.
 */
export function isLoopbackHostname(hostname: string): boolean {
  let normalized = hostname.toLowerCase();
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
