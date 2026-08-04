import { createWorkerIdentity } from "../protocol/control.ts";
import type {
  JsonObject,
  JsonValue,
  WorkerIdentity,
} from "../protocol/types.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKLOAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_JSON_DEPTH = 32;

export type SupervisorErrorCode =
  | "already_exists"
  | "capacity_exhausted"
  | "credential_expired"
  | "credential_invalid"
  | "invalid_state"
  | "not_found"
  | "stale_attempt"
  | "stale_session";

export type SupervisorError =
  & Error
  & Readonly<{
    code: SupervisorErrorCode;
  }>;

export function fail(
  code: SupervisorErrorCode,
  message: string,
): never {
  const error = new Error(message) as SupervisorError;
  Object.defineProperty(error, "code", {
    configurable: false,
    enumerable: true,
    value: code,
    writable: false,
  });
  throw error;
}

export function expectFiniteTimestamp(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

export function expectPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function expectIdentifier(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw new TypeError(`${name} has an invalid identifier`);
  }
  return value;
}

export function expectWorkload(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !WORKLOAD_PATTERN.test(value)
  ) {
    throw new TypeError(`${name} has an invalid workload identifier`);
  }
  return value;
}

export function copyIdentity(identity: WorkerIdentity): WorkerIdentity {
  return Object.freeze(createWorkerIdentity(identity));
}

export function sameIdentity(
  left: WorkerIdentity,
  right: WorkerIdentity,
): boolean {
  return left.workerId === right.workerId &&
    left.attemptId === right.attemptId &&
    left.epoch === right.epoch;
}

function copyJsonValue(
  value: JsonValue,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("expected a JSON value");
  }
  if (depth >= MAX_JSON_DEPTH) {
    throw new TypeError(`JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
  }
  if (seen.has(value)) {
    throw new TypeError("JSON values must not contain cycles");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((entry) => copyJsonValue(entry, depth + 1, seen)),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }

    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError("JSON objects must not contain symbol keys");
      }
      const entry = copyJsonValue(
        (value as Record<string, JsonValue>)[key],
        depth + 1,
        seen,
      );
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: entry,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    seen.delete(value);
  }
}

export function copyJsonObject(value: JsonObject = {}): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("expected a JSON object");
  }
  return copyJsonValue(value, 0, new WeakSet()) as JsonObject;
}

export function copyUniqueWorkloads(
  workloads: readonly string[],
): readonly string[] {
  if (!Array.isArray(workloads) || workloads.length === 0) {
    throw new TypeError("workloads must be a non-empty array");
  }
  const copy = workloads.map((workload, index) =>
    expectWorkload(workload, `workloads[${index}]`)
  );
  if (new Set(copy).size !== copy.length) {
    throw new TypeError("workloads must be unique");
  }
  return Object.freeze(copy);
}

export function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
