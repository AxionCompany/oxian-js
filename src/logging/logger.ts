export type LogLevel = "debug" | "info" | "warn" | "error";

export function createLogger(level: LogLevel = "info") {
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  const minIdx = order.indexOf(level);
  function log(lvl: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (order.indexOf(lvl) < minIdx) return;
    const entry = { level: lvl, msg, time: new Date().toISOString(), ...(meta ?? {}) };
    console.log(JSON.stringify(entry));
  }
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  };
}

export function redactHeaders(headers: Headers, scrub: string[] = []) {
  const lower = new Set(scrub.map((s) => s.toLowerCase()));
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = lower.has(k.toLowerCase()) ? "<redacted>" : v;
  });
  return out;
}

export function makeRequestLog({
  requestId,
  route,
  method,
  status,
  durationMs,
  headers,
  scrubHeaders: scrub,
}: {
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  headers: Headers;
  scrubHeaders?: string[];
}) {
  return {
    requestId,
    route,
    method,
    status,
    durationMs,
    headers: redactHeaders(headers, scrub),
  };
} 