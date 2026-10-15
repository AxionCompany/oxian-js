import type { JsonValue } from "../protocol/types.ts";
import type {
  CommandIdentity,
  CommandRequest,
  OwnerError,
  OwnerErrorCode,
} from "./types.ts";

export function createOwnerError(
  code: OwnerErrorCode,
  message: string,
  cause?: unknown,
): OwnerError {
  const error = new Error(message, {
    ...(cause === undefined ? {} : { cause }),
  }) as OwnerError;
  Object.defineProperties(error, {
    name: { configurable: true, value: "OwnerError", writable: true },
    code: { enumerable: true, value: code },
  });
  return error;
}

export function isOwnerError(
  error: unknown,
  code?: OwnerErrorCode,
): error is OwnerError {
  return (
    error instanceof Error &&
    error.name === "OwnerError" &&
    (code === undefined || (error as OwnerError).code === code)
  );
}

/** A request the caller can no longer change. */
export function snapshotRequest(request: CommandRequest): CommandRequest {
  if (request === null || typeof request !== "object") {
    throw new TypeError("command request must be an object");
  }
  const identity = request.identity;
  return Object.freeze({
    type: request.type,
    identity: Object.freeze({
      domain: identity?.domain,
      key: identity?.key,
    }),
    input: structuredClone(request.input ?? null),
  });
}

export function identityKey(identity: CommandIdentity): string {
  return `${identity.domain}:${identity.key}`;
}

/** Digest of a request, so a reused identity with a different request is detected. */
export async function fingerprintRequest(
  type: string,
  input: JsonValue,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson([type, input]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item: JsonValue) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(",")}}`;
}
