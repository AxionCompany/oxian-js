import { dirname, fromFileUrl, resolve, toFileUrl } from "@std/path";
import { HTTP_WORKLOAD } from "../http/types.ts";
import { createHelloFrame } from "../protocol/control.ts";
import type { WorkerCredential, WorkerIdentity } from "../protocol/types.ts";
import type { LoadWorkerManifestSource, WorkerManifest } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

const TOP_LEVEL_KEYS = Object.freeze([
  "gatewayUrl",
  "identity",
  "credential",
  "handshakeId",
  "resumeExpiresAtMs",
  "capacity",
  "applicationConfig",
  "credentialStore",
]);

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as UnknownRecord;
}

function expectExactKeys(
  record: UnknownRecord,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  path: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${path} contains unknown key "${String(key)}"`);
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
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`${path} is missing "${key}"`);
    }
  }
}

function localTypescriptUrl(
  source: string | URL,
  path: string,
  baseDirectory?: string,
): URL {
  let url: URL;
  if (source instanceof URL) {
    url = new URL(source.href);
  } else if (typeof source === "string" && source.length > 0) {
    if (
      !/^[a-zA-Z]:[\\/]/.test(source) &&
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)
    ) {
      try {
        url = new URL(source);
      } catch {
        throw new TypeError(`${path} must be a local TypeScript module`);
      }
    } else {
      url = toFileUrl(resolve(baseDirectory ?? Deno.cwd(), source));
    }
  } else {
    throw new TypeError(`${path} must be a local TypeScript module`);
  }
  if (
    url.protocol !== "file:" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(".ts")
  ) {
    throw new TypeError(
      `${path} must be a local .ts module without a query or fragment`,
    );
  }
  return url;
}

function localPath(
  value: unknown,
  path: string,
  baseDirectory: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty local path`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${path} must not contain a null byte`);
  }
  if (
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
  ) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError(`${path} must be a local path`);
    }
    if (
      url.protocol !== "file:" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new TypeError(`${path} must be a local path or file: URL`);
    }
    return fromFileUrl(url);
  }
  return resolve(baseDirectory, value);
}

function gatewayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("worker manifest.gatewayUrl must be a WebSocket URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("worker manifest.gatewayUrl must be a WebSocket URL");
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "worker manifest.gatewayUrl must be a credential-free ws: or wss: URL without query or fragment",
    );
  }
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new TypeError(
      "worker manifest.gatewayUrl may use ws: only for a loopback host",
    );
  }
  return url.href;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]";
}

function normalizeManifest(
  value: unknown,
  baseDirectory: string,
): WorkerManifest {
  const record = expectRecord(value, "worker manifest");
  expectExactKeys(
    record,
    TOP_LEVEL_KEYS,
    [
      "gatewayUrl",
      "identity",
      "credential",
      "handshakeId",
      "capacity",
      "applicationConfig",
      "credentialStore",
    ],
    "worker manifest",
  );

  const identityRecord = expectRecord(
    record.identity,
    "worker manifest.identity",
  );
  expectExactKeys(
    identityRecord,
    ["workerId", "attemptId", "epoch"],
    ["workerId", "attemptId", "epoch"],
    "worker manifest.identity",
  );
  const credentialRecord = expectRecord(
    record.credential,
    "worker manifest.credential",
  );
  expectExactKeys(
    credentialRecord,
    ["kind", "capability"],
    ["kind", "capability"],
    "worker manifest.credential",
  );

  const hello = createHelloFrame({
    handshakeId: record.handshakeId as string,
    identity: identityRecord as WorkerIdentity,
    credential: credentialRecord as WorkerCredential,
    workloads: [HTTP_WORKLOAD],
    capacity: record.capacity as number,
  });

  let resumeExpiresAtMs: number | undefined;
  if (hello.credential.kind === "resume") {
    if (
      typeof record.resumeExpiresAtMs !== "number" ||
      !Number.isSafeInteger(record.resumeExpiresAtMs) ||
      record.resumeExpiresAtMs < 0
    ) {
      throw new TypeError(
        "worker manifest.resumeExpiresAtMs is required with a resume credential",
      );
    }
    resumeExpiresAtMs = record.resumeExpiresAtMs;
  } else if (record.resumeExpiresAtMs !== undefined) {
    throw new TypeError(
      "worker manifest.resumeExpiresAtMs is valid only with a resume credential",
    );
  }

  const applicationConfig = localTypescriptUrl(
    record.applicationConfig as string,
    "worker manifest.applicationConfig",
    baseDirectory,
  );
  const storeRecord = expectRecord(
    record.credentialStore,
    "worker manifest.credentialStore",
  );
  let credentialStore: WorkerManifest["credentialStore"];
  if (storeRecord.mode === "ephemeral") {
    expectExactKeys(
      storeRecord,
      ["mode"],
      ["mode"],
      "worker manifest.credentialStore",
    );
    credentialStore = Object.freeze({ mode: "ephemeral" });
  } else if (storeRecord.mode === "durable") {
    expectExactKeys(
      storeRecord,
      ["mode", "path"],
      ["mode", "path"],
      "worker manifest.credentialStore",
    );
    credentialStore = Object.freeze({
      mode: "durable",
      path: localPath(
        storeRecord.path,
        "worker manifest.credentialStore.path",
        baseDirectory,
      ),
    });
  } else {
    throw new TypeError(
      'worker manifest.credentialStore.mode must be "durable" or "ephemeral"',
    );
  }

  return Object.freeze({
    gatewayUrl: gatewayUrl(record.gatewayUrl),
    identity: hello.identity,
    credential: hello.credential,
    handshakeId: hello.handshakeId,
    ...(resumeExpiresAtMs === undefined ? {} : { resumeExpiresAtMs }),
    capacity: hello.capacity,
    applicationConfig: applicationConfig.href,
    credentialStore,
  });
}

function selectExport(module: Readonly<Record<string, unknown>>): unknown {
  const exports = Object.keys(module).sort();
  const hasDefault = Object.hasOwn(module, "default");
  const hasManifest = Object.hasOwn(module, "manifest");
  if (hasDefault === hasManifest) {
    throw new TypeError(
      'worker manifest module must export exactly one of "default" or "manifest"',
    );
  }
  const selected = hasDefault ? "default" : "manifest";
  const extra = exports.find((name) => name !== selected);
  if (extra !== undefined) {
    throw new TypeError(
      `worker manifest module may only export "${selected}"; found extra export "${extra}"`,
    );
  }
  return module[selected];
}

export async function loadWorkerManifest(
  source: LoadWorkerManifestSource,
): Promise<WorkerManifest> {
  const url = localTypescriptUrl(source, "worker manifest source");
  const module = await import(url.href) as Readonly<Record<string, unknown>>;
  return normalizeManifest(
    selectExport(module),
    dirname(fromFileUrl(url)),
  );
}
