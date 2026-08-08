import { isAbsolute, normalize, resolve } from "@std/path";
import {
  createHypervisorConfig,
  DEFAULT_HYPERVISOR_CONFIG,
} from "../hypervisor/config.ts";
import { normalizeApplicationBasePath } from "../app/base_path.ts";
import type {
  CorsConfig,
  DevProxyConfig,
  EdgeConfig,
  OxianConfig,
  StaticConfig,
} from "./types.ts";

const DEFAULT_CORS_METHODS = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-zA-Z]:[\\/]/;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

const TOP_LEVEL_KEYS = new Set(["application", "gateway"]);
const APPLICATION_KEYS = new Set(["routesRoot", "basePath", "factory"]);
const GATEWAY_KEYS = new Set([
  "listener",
  "workerTransport",
  "hypervisor",
  "edge",
]);
const LISTENER_KEYS = new Set(["hostname", "port"]);
const HYPERVISOR_KEYS = new Set(
  Object.keys(DEFAULT_HYPERVISOR_CONFIG),
);
const EDGE_KEYS = new Set(["cors", "static", "devProxy"]);
const CORS_KEYS = new Set([
  "origins",
  "methods",
  "headers",
  "exposeHeaders",
  "credentials",
  "maxAgeSeconds",
]);
const STATIC_KEYS = new Set([
  "root",
  "prefix",
  "index",
  "cacheControl",
  "fallthrough",
]);
const DEV_PROXY_KEYS = new Set([
  "upstream",
  "prefix",
  "stripPrefix",
  "forwardHost",
]);

type PlainRecord = Record<string, unknown>;

type NormalizationContext = Readonly<{
  baseDirectory?: string;
}>;

function normalizeWorkerTransport(
  value: unknown,
): "in-process" | "websocket" {
  if (value === undefined || value === "in-process") return "in-process";
  if (value === "websocket") return value;
  throw new TypeError(
    'config.gateway.workerTransport must be "in-process" or "websocket"',
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function expectPlainRecord(value: unknown, path: string): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(
      `${path} must be a plain object; received ${describe(value)}`,
    );
  }
  return value as PlainRecord;
}

function assertExactKeys(
  record: PlainRecord,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      throw new TypeError(`${path} must not contain symbol keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `${path}.${key} must be an enumerable data property`,
      );
    }
    if (!allowed.has(key)) {
      throw new TypeError(`${path} contains unknown key "${key}"`);
    }
  }
}

function optionalRecord(
  value: unknown,
  path: string,
): PlainRecord | undefined {
  return value === undefined ? undefined : expectPlainRecord(value, path);
}

function expectBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
): boolean {
  const selected = value === undefined ? fallback : value;
  if (typeof selected !== "boolean") {
    throw new TypeError(`${path} must be a boolean`);
  }
  return selected;
}

function expectString(
  value: unknown,
  path: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0)
  ) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(
  value: unknown,
  fallback: readonly string[],
  path: string,
  normalizeValue: (value: string) => string = (entry) => entry,
): readonly string[] {
  const selected = value === undefined ? fallback : value;
  if (
    !Array.isArray(selected) ||
    Object.getPrototypeOf(selected) !== Array.prototype
  ) {
    throw new TypeError(`${path} must be an array of strings`);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < selected.length; index += 1) {
    if (!Object.hasOwn(selected, index)) {
      throw new TypeError(`${path} must not be sparse`);
    }
    const candidate = selected[index];
    if (typeof candidate !== "string") {
      throw new TypeError(`${path}[${index}] must be a string`);
    }
    const normalized = normalizeValue(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  for (const key of Reflect.ownKeys(selected)) {
    if (
      key === "length" ||
      (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key))
    ) {
      continue;
    }
    throw new TypeError(`${path} must not contain custom properties`);
  }

  return Object.freeze(result);
}

function normalizeLocalPath(
  value: unknown,
  fallback: string | undefined,
  path: string,
  baseDirectory: string | undefined,
): string {
  const selected = expectString(
    value === undefined ? fallback : value,
    path,
  );
  if (selected.includes("\0")) {
    throw new TypeError(`${path} must not contain a null byte`);
  }

  const looksLikeWindowsPath = WINDOWS_ABSOLUTE_PATH_PATTERN.test(selected);
  if (!looksLikeWindowsPath && URI_SCHEME_PATTERN.test(selected)) {
    let url: URL;
    try {
      url = new URL(selected);
    } catch {
      throw new TypeError(
        `${path} must be a local filesystem path or file: URL`,
      );
    }
    if (
      url.protocol !== "file:" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError(
        `${path} must be a local filesystem path or file: URL without a query or fragment`,
      );
    }
    return url.href;
  }

  if (baseDirectory !== undefined && !isAbsolute(selected)) {
    return resolve(baseDirectory, selected);
  }
  return isAbsolute(selected) ? normalize(selected) : selected;
}

function normalizeLocalTypescriptPath(
  value: unknown,
  path: string,
  baseDirectory: string | undefined,
): string {
  const normalized = normalizeLocalPath(
    value,
    undefined,
    path,
    baseDirectory,
  );
  const fileUrl = normalized.startsWith("file:")
    ? new URL(normalized)
    : undefined;
  if (fileUrl !== undefined && fileUrl.hostname !== "") {
    throw new TypeError(`${path} must reference a local .ts module`);
  }
  const pathname = fileUrl?.pathname ?? normalized;
  if (!pathname.endsWith(".ts")) {
    throw new TypeError(`${path} must reference a local .ts module`);
  }
  return normalized;
}

function normalizeHostname(value: unknown): string {
  const hostname = expectString(
    value === undefined ? "127.0.0.1" : value,
    "config.gateway.listener.hostname",
  );
  if (
    hostname !== hostname.trim() ||
    hostname.includes("\0") ||
    hostname.includes("/") ||
    hostname.includes("?") ||
    hostname.includes("#") ||
    hostname.includes("@")
  ) {
    throw new TypeError(
      "config.gateway.listener.hostname must be a bare hostname or IP address",
    );
  }

  try {
    const authority = hostname.includes(":") ? `[${hostname}]` : hostname;
    const parsed = new URL(`http://${authority}/`);
    if (parsed.hostname.length === 0) throw new Error("empty hostname");
  } catch {
    throw new TypeError(
      "config.gateway.listener.hostname must be a bare hostname or IP address",
    );
  }
  return hostname;
}

function normalizePort(value: unknown): number {
  const port = value === undefined ? 8_000 : value;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65_535
  ) {
    throw new TypeError(
      "config.gateway.listener.port must be an integer between 0 and 65535",
    );
  }
  return port;
}

function normalizeHttpToken(
  value: string,
  path: string,
  uppercase: boolean,
): string {
  if (!HTTP_TOKEN_PATTERN.test(value)) {
    throw new TypeError(`${path} must contain valid HTTP tokens`);
  }
  return uppercase ? value.toUpperCase() : value.toLowerCase();
}

function isSerializedOrigin(origin: string): boolean {
  if (origin === "null") return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === origin &&
      parsed.username === "" &&
      parsed.password === "";
  } catch {
    return false;
  }
}

function normalizeCors(value: unknown): CorsConfig {
  const record = expectPlainRecord(value, "config.gateway.edge.cors");
  assertExactKeys(record, CORS_KEYS, "config.gateway.edge.cors");
  if (!Object.hasOwn(record, "origins") || record.origins === undefined) {
    throw new TypeError("config.gateway.edge.cors.origins is required");
  }

  let origins: "*" | readonly string[];
  if (record.origins === "*") {
    origins = "*";
  } else {
    origins = expectStringArray(
      record.origins,
      [],
      "config.gateway.edge.cors.origins",
      (origin) => {
        if (!isSerializedOrigin(origin)) {
          throw new TypeError(
            'config.gateway.edge.cors.origins must contain serialized HTTP(S) origins or "null"',
          );
        }
        return origin;
      },
    );
  }

  const methods = expectStringArray(
    record.methods,
    DEFAULT_CORS_METHODS,
    "config.gateway.edge.cors.methods",
    (method) =>
      normalizeHttpToken(
        method,
        "config.gateway.edge.cors.methods",
        true,
      ),
  );
  const headers = expectStringArray(
    record.headers,
    [],
    "config.gateway.edge.cors.headers",
    (header) =>
      normalizeHttpToken(
        header,
        "config.gateway.edge.cors.headers",
        false,
      ),
  );
  const exposeHeaders = expectStringArray(
    record.exposeHeaders,
    [],
    "config.gateway.edge.cors.exposeHeaders",
    (header) =>
      normalizeHttpToken(
        header,
        "config.gateway.edge.cors.exposeHeaders",
        false,
      ),
  );
  const credentials = expectBoolean(
    record.credentials,
    false,
    "config.gateway.edge.cors.credentials",
  );
  if (credentials && origins === "*") {
    throw new TypeError(
      "config.gateway.edge.cors.credentials cannot be true with wildcard origins",
    );
  }

  let maxAgeSeconds: number | undefined;
  if (record.maxAgeSeconds !== undefined) {
    if (
      typeof record.maxAgeSeconds !== "number" ||
      !Number.isSafeInteger(record.maxAgeSeconds) ||
      record.maxAgeSeconds < 0
    ) {
      throw new TypeError(
        "config.gateway.edge.cors.maxAgeSeconds must be a non-negative safe integer",
      );
    }
    maxAgeSeconds = record.maxAgeSeconds;
  }

  return Object.freeze({
    origins,
    methods,
    headers,
    exposeHeaders,
    credentials,
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
  });
}

function normalizeUrlPrefix(value: unknown, path: string): string {
  const prefix = expectString(value === undefined ? "/" : value, path);
  if (
    !prefix.startsWith("/") ||
    prefix.includes("?") ||
    prefix.includes("#") ||
    prefix.includes("\\") ||
    prefix.includes("\0")
  ) {
    throw new TypeError(`${path} must be an absolute URL path`);
  }
  if (
    prefix.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`${path} must not contain traversal segments`);
  }
  return prefix === "/" ? prefix : prefix.replace(/\/+$/, "");
}

function normalizeRelativePath(value: string, path: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new TypeError(`${path} must contain relative paths`);
  }
  if (
    value.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new TypeError(
      `${path} must not contain empty or traversal segments`,
    );
  }
  return value;
}

function normalizeStatic(
  value: unknown,
  baseDirectory: string | undefined,
): StaticConfig {
  const record = expectPlainRecord(value, "config.gateway.edge.static");
  assertExactKeys(record, STATIC_KEYS, "config.gateway.edge.static");
  if (!Object.hasOwn(record, "root")) {
    throw new TypeError("config.gateway.edge.static.root is required");
  }

  let index: readonly string[];
  if (record.index === false) {
    index = Object.freeze([]);
  } else if (typeof record.index === "string") {
    index = Object.freeze([
      normalizeRelativePath(
        record.index,
        "config.gateway.edge.static.index",
      ),
    ]);
  } else {
    index = expectStringArray(
      record.index,
      ["index.html"],
      "config.gateway.edge.static.index",
      (entry) =>
        normalizeRelativePath(
          entry,
          "config.gateway.edge.static.index",
        ),
    );
  }

  let cacheControl: string | undefined;
  if (record.cacheControl !== undefined) {
    cacheControl = expectString(
      record.cacheControl,
      "config.gateway.edge.static.cacheControl",
    );
    if (
      cacheControl.includes("\r") ||
      cacheControl.includes("\n")
    ) {
      throw new TypeError(
        "config.gateway.edge.static.cacheControl must not contain line breaks",
      );
    }
  }

  return Object.freeze({
    root: normalizeLocalPath(
      record.root,
      undefined,
      "config.gateway.edge.static.root",
      baseDirectory,
    ),
    prefix: normalizeUrlPrefix(
      record.prefix,
      "config.gateway.edge.static.prefix",
    ),
    index,
    ...(cacheControl === undefined ? {} : { cacheControl }),
    fallthrough: expectBoolean(
      record.fallthrough,
      true,
      "config.gateway.edge.static.fallthrough",
    ),
  });
}

function normalizeDevProxy(value: unknown): DevProxyConfig {
  const record = expectPlainRecord(value, "config.gateway.edge.devProxy");
  assertExactKeys(record, DEV_PROXY_KEYS, "config.gateway.edge.devProxy");
  if (!Object.hasOwn(record, "upstream")) {
    throw new TypeError("config.gateway.edge.devProxy.upstream is required");
  }

  const upstreamValue = expectString(
    record.upstream,
    "config.gateway.edge.devProxy.upstream",
  );
  let upstream: URL;
  try {
    upstream = new URL(upstreamValue);
  } catch {
    throw new TypeError(
      "config.gateway.edge.devProxy.upstream must be an absolute HTTP(S) URL",
    );
  }
  if (
    (upstream.protocol !== "http:" && upstream.protocol !== "https:") ||
    upstream.hostname.length === 0 ||
    upstream.search !== "" ||
    upstream.hash !== ""
  ) {
    throw new TypeError(
      "config.gateway.edge.devProxy.upstream must be an absolute HTTP(S) URL without a query or fragment",
    );
  }
  if (upstream.username !== "" || upstream.password !== "") {
    throw new TypeError(
      "config.gateway.edge.devProxy.upstream must not contain credentials",
    );
  }

  return Object.freeze({
    upstream: upstream.href,
    prefix: normalizeUrlPrefix(
      record.prefix,
      "config.gateway.edge.devProxy.prefix",
    ),
    stripPrefix: expectBoolean(
      record.stripPrefix,
      false,
      "config.gateway.edge.devProxy.stripPrefix",
    ),
    forwardHost: expectBoolean(
      record.forwardHost,
      false,
      "config.gateway.edge.devProxy.forwardHost",
    ),
  });
}

function normalizeEdge(
  value: unknown,
  baseDirectory: string | undefined,
): EdgeConfig | undefined {
  const record = optionalRecord(value, "config.gateway.edge");
  if (record === undefined) return undefined;
  assertExactKeys(record, EDGE_KEYS, "config.gateway.edge");

  return Object.freeze({
    ...(record.cors === undefined ? {} : { cors: normalizeCors(record.cors) }),
    ...(record.static === undefined
      ? {}
      : { static: normalizeStatic(record.static, baseDirectory) }),
    ...(record.devProxy === undefined
      ? {}
      : { devProxy: normalizeDevProxy(record.devProxy) }),
  });
}

export function normalizeConfig(
  input: unknown,
  context: NormalizationContext = {},
): OxianConfig {
  const config = expectPlainRecord(input, "config");
  assertExactKeys(config, TOP_LEVEL_KEYS, "config");

  const application = optionalRecord(
    config.application,
    "config.application",
  ) ?? {};
  assertExactKeys(application, APPLICATION_KEYS, "config.application");

  const gateway = optionalRecord(config.gateway, "config.gateway") ?? {};
  assertExactKeys(gateway, GATEWAY_KEYS, "config.gateway");

  const listener = optionalRecord(
    gateway.listener,
    "config.gateway.listener",
  ) ?? {};
  assertExactKeys(listener, LISTENER_KEYS, "config.gateway.listener");

  const hypervisor = optionalRecord(
    gateway.hypervisor,
    "config.gateway.hypervisor",
  ) ?? {};
  assertExactKeys(
    hypervisor,
    HYPERVISOR_KEYS,
    "config.gateway.hypervisor",
  );
  for (const [key, value] of Object.entries(hypervisor)) {
    if (value === null) {
      throw new TypeError(
        `config.gateway.hypervisor.${key} must not be null`,
      );
    }
  }

  const edge = normalizeEdge(gateway.edge, context.baseDirectory);

  return Object.freeze({
    application: Object.freeze({
      routesRoot: normalizeLocalPath(
        application.routesRoot,
        "./routes",
        "config.application.routesRoot",
        context.baseDirectory,
      ),
      basePath: normalizeApplicationBasePath(
        application.basePath,
        "config.application.basePath",
      ),
      ...(application.factory === undefined ? {} : {
        factory: normalizeLocalTypescriptPath(
          application.factory,
          "config.application.factory",
          context.baseDirectory,
        ),
      }),
    }),
    gateway: Object.freeze({
      listener: Object.freeze({
        hostname: normalizeHostname(listener.hostname),
        port: normalizePort(listener.port),
      }),
      workerTransport: normalizeWorkerTransport(gateway.workerTransport),
      hypervisor: createHypervisorConfig(hypervisor),
      ...(edge === undefined ? {} : { edge }),
    }),
  }) satisfies OxianConfig;
}
