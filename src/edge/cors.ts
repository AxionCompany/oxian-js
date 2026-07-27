import type {
  CorsAdapterOptions,
  CorsOriginPolicy,
  FetchAdapter,
} from "./types.ts";

const DEFAULT_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

type CorsConfiguration = Readonly<{
  origins: CorsOriginPolicy;
  methods: readonly string[];
  methodSet: ReadonlySet<string>;
  headers: readonly string[];
  headerSet: ReadonlySet<string>;
  exposeHeaders: readonly string[];
  credentials: boolean;
  maxAgeSeconds?: number;
}>;

function copyHeaders(source: Headers): Headers {
  const target = new Headers();
  const cookies = typeof source.getSetCookie === "function"
    ? source.getSetCookie()
    : [];
  let copiedCookies = false;

  for (const [name, value] of source) {
    if (name.toLowerCase() === "set-cookie" && cookies.length > 0) {
      if (!copiedCookies) {
        for (const cookie of cookies) target.append("set-cookie", cookie);
        copiedCookies = true;
      }
      continue;
    }
    target.append(name, value);
  }
  if (!copiedCookies) {
    for (const cookie of cookies) target.append("set-cookie", cookie);
  }
  return target;
}

function mergeVary(headers: Headers, ...names: readonly string[]): void {
  const current = headers.get("vary");
  if (current?.trim() === "*") return;

  const values = current === null
    ? []
    : current.split(",").map((value) => value.trim()).filter(Boolean);
  const known = new Set(values.map((value) => value.toLowerCase()));
  for (const name of names) {
    if (!known.has(name.toLowerCase())) {
      known.add(name.toLowerCase());
      values.push(name);
    }
  }
  if (values.length > 0) headers.set("vary", values.join(", "));
}

function withHeaders(
  response: Response,
  update: (headers: Headers) => void,
): Response {
  const headers = copyHeaders(response.headers);
  update(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeTokens(
  values: readonly string[] | undefined,
  fallback: readonly string[],
  label: string,
  uppercase: boolean,
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values ?? fallback) {
    if (
      typeof candidate !== "string" ||
      !HTTP_TOKEN_PATTERN.test(candidate)
    ) {
      throw new TypeError(`${label} must contain valid HTTP tokens`);
    }
    const value = uppercase ? candidate.toUpperCase() : candidate.toLowerCase();
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return Object.freeze(result);
}

function isSerializedOrigin(origin: string): boolean {
  if (origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin;
  } catch {
    return false;
  }
}

function normalizeOrigins(policy: CorsOriginPolicy): CorsOriginPolicy {
  if (policy === "*" || typeof policy === "function") return policy;
  if (!Array.isArray(policy)) {
    throw new TypeError("cors origins must be '*', an array, or a predicate");
  }
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const origin of policy) {
    if (typeof origin !== "string" || !isSerializedOrigin(origin)) {
      throw new TypeError(
        "cors origins must be serialized HTTP(S) origins or 'null'",
      );
    }
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  }
  return Object.freeze(origins);
}

function createConfiguration(
  options: CorsAdapterOptions,
): CorsConfiguration {
  const origins = normalizeOrigins(options.origins);
  const credentials = options.credentials ?? false;
  if (credentials && origins === "*") {
    throw new TypeError(
      "cors credentials cannot be combined with a wildcard origin",
    );
  }
  if (
    options.maxAgeSeconds !== undefined &&
    (!Number.isSafeInteger(options.maxAgeSeconds) ||
      options.maxAgeSeconds < 0)
  ) {
    throw new TypeError(
      "cors maxAgeSeconds must be a non-negative safe integer",
    );
  }

  const methods = normalizeTokens(
    options.methods,
    DEFAULT_METHODS,
    "cors methods",
    true,
  );
  const headers = normalizeTokens(
    options.headers,
    [],
    "cors headers",
    false,
  );
  const exposeHeaders = normalizeTokens(
    options.exposeHeaders,
    [],
    "cors exposeHeaders",
    false,
  );
  return Object.freeze({
    origins,
    methods,
    methodSet: new Set(methods),
    headers,
    headerSet: new Set(headers),
    exposeHeaders,
    credentials,
    maxAgeSeconds: options.maxAgeSeconds,
  });
}

function parseRequestedHeaders(value: string | null): readonly string[] | null {
  if (value === null || value.trim() === "") return Object.freeze([]);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const header = entry.trim().toLowerCase();
    if (!HTTP_TOKEN_PATTERN.test(header)) return null;
    if (!seen.has(header)) {
      seen.add(header);
      result.push(header);
    }
  }
  return Object.freeze(result);
}

async function permitsOrigin(
  policy: CorsOriginPolicy,
  origin: string,
  request: Request,
): Promise<boolean> {
  if (!isSerializedOrigin(origin)) return false;
  if (policy === "*") return true;
  if (typeof policy === "function") {
    return await policy(origin, request) === true;
  }
  return policy.includes(origin);
}

function applyActualHeaders(
  headers: Headers,
  config: CorsConfiguration,
  origin: string,
  allowed: boolean,
): void {
  headers.delete("access-control-allow-origin");
  headers.delete("access-control-allow-credentials");
  headers.delete("access-control-allow-methods");
  headers.delete("access-control-allow-headers");
  headers.delete("access-control-expose-headers");
  headers.delete("access-control-max-age");
  if (config.origins !== "*") mergeVary(headers, "Origin");
  if (!allowed) return;
  headers.set(
    "access-control-allow-origin",
    config.origins === "*" ? "*" : origin,
  );
  if (config.credentials) {
    headers.set("access-control-allow-credentials", "true");
  }
  if (config.exposeHeaders.length > 0) {
    headers.set(
      "access-control-expose-headers",
      config.exposeHeaders.join(", "),
    );
  }
}

function preflightResponse(
  config: CorsConfiguration,
  origin: string,
  allowed: boolean,
  requestedMethod: string | null,
  requestedHeaders: readonly string[] | null,
): Response {
  const headers = new Headers();
  if (config.origins !== "*") mergeVary(headers, "Origin");
  mergeVary(
    headers,
    "Access-Control-Request-Method",
    "Access-Control-Request-Headers",
  );

  const method = requestedMethod?.toUpperCase();
  const requestIsValid = allowed &&
    method !== undefined &&
    HTTP_TOKEN_PATTERN.test(method) &&
    config.methodSet.has(method) &&
    requestedHeaders !== null &&
    requestedHeaders.every((header) => config.headerSet.has(header));
  if (!requestIsValid) return new Response(null, { status: 403, headers });

  headers.set(
    "access-control-allow-origin",
    config.origins === "*" ? "*" : origin,
  );
  headers.set("access-control-allow-methods", config.methods.join(", "));
  if (requestedHeaders.length > 0) {
    headers.set("access-control-allow-headers", config.headers.join(", "));
  }
  if (config.credentials) {
    headers.set("access-control-allow-credentials", "true");
  }
  if (config.maxAgeSeconds !== undefined) {
    headers.set(
      "access-control-max-age",
      String(config.maxAgeSeconds),
    );
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Creates a strict Fetch wrapper implementing browser CORS. CORS is not an
 * authorization mechanism: disallowed non-preflight requests still reach the
 * wrapped handler, but receive no access-control grant.
 */
export function createCorsAdapter(
  options: CorsAdapterOptions,
): FetchAdapter {
  const config = createConfiguration(options);
  return (next) => {
    if (typeof next !== "function") {
      throw new TypeError("cors adapter expects a Fetch handler");
    }
    return async (request) => {
      const origin = request.headers.get("origin");
      if (origin === null) {
        const response = await next(request);
        return withHeaders(
          response,
          (headers) =>
            applyActualHeaders(
              headers,
              config,
              "",
              config.origins === "*",
            ),
        );
      }

      const allowed = await permitsOrigin(config.origins, origin, request);
      const isPreflight = request.method.toUpperCase() === "OPTIONS" &&
        request.headers.has("access-control-request-method");
      if (isPreflight) {
        return preflightResponse(
          config,
          origin,
          allowed,
          request.headers.get("access-control-request-method"),
          parseRequestedHeaders(
            request.headers.get("access-control-request-headers"),
          ),
        );
      }

      const response = await next(request);
      return withHeaders(
        response,
        (headers) => applyActualHeaders(headers, config, origin, allowed),
      );
    };
  };
}
