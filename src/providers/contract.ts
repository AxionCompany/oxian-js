import { createWorkerIdentity } from "../protocol/control.ts";
import type { JsonObject, JsonValue } from "../protocol/types.ts";
import type {
  ProviderError,
  ProviderErrorCode,
  ProviderInspection,
  ProviderResource,
  ProviderResourceState,
  ProviderTermination,
  ProviderTerminationOutcome,
} from "./types.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_PROVIDER_ID_LENGTH = 128;
const MAX_RESOURCE_ID_LENGTH = 512;
const MAX_JSON_DEPTH = 32;
const PROVIDER_RESOURCE_STATES = new Set<ProviderResourceState>([
  "present",
  "absent",
  "failed",
  "unknown",
]);
const PROVIDER_TERMINATION_OUTCOMES = new Set<ProviderTerminationOutcome>([
  "terminated",
  "already_absent",
  "unknown",
]);

function assertNonEmptyString(
  value: unknown,
  field: string,
  maxLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
}

export function validateProviderId(providerId: string): string {
  assertNonEmptyString(
    providerId,
    "providerId",
    MAX_PROVIDER_ID_LENGTH,
  );
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new TypeError(
      "providerId must start with an alphanumeric character and contain only alphanumeric, dot, underscore, colon, or dash characters",
    );
  }
  return providerId;
}

export function validateProviderResourceId(resourceId: string): string {
  assertNonEmptyString(
    resourceId,
    "resourceId",
    MAX_RESOURCE_ID_LENGTH,
  );
  for (const character of resourceId) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError("resourceId must not contain control characters");
    }
  }
  return resourceId;
}

function failJson(path: string, message: string): never {
  throw new TypeError(`Invalid provider JSON at ${path}: ${message}`);
}

function cloneAndFreezeJsonValue(
  value: unknown,
  path: string,
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
      return failJson(path, "numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    return failJson(path, "expected a JSON value");
  }
  if (depth >= MAX_JSON_DEPTH) {
    return failJson(path, `nesting exceeds ${MAX_JSON_DEPTH} levels`);
  }
  if (seen.has(value)) {
    return failJson(path, "cycles are not allowed");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= value.length
        ) {
          return failJson(path, "arrays must not have extra properties");
        }
      }

      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          return failJson(
            `${path}[${index}]`,
            "expected an enumerable data element",
          );
        }
        clone.push(
          cloneAndFreezeJsonValue(
            descriptor.value,
            `${path}[${index}]`,
            depth + 1,
            seen,
          ),
        );
      }
      return Object.freeze(clone);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return failJson(path, "expected a plain object");
    }

    const clone: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return failJson(path, "symbol keys are not allowed");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return failJson(
          `${path}.${key}`,
          "expected an enumerable data property",
        );
      }
      Object.defineProperty(clone, key, {
        configurable: false,
        enumerable: true,
        value: cloneAndFreezeJsonValue(
          descriptor.value,
          `${path}.${key}`,
          depth + 1,
          seen,
        ),
        writable: false,
      });
    }
    return Object.freeze(clone);
  } finally {
    seen.delete(value);
  }
}

export function cloneProviderJsonObject(
  value: unknown,
  path = "$",
): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return failJson(path, "expected a plain object");
  }
  return cloneAndFreezeJsonValue(
    value,
    path,
    0,
    new WeakSet(),
  ) as JsonObject;
}

function providerJsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return false;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => providerJsonEquals(value, right[index]));
  }

  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject);
  const rightKeys = Object.keys(rightObject);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      Object.hasOwn(rightObject, key) &&
      providerJsonEquals(leftObject[key], rightObject[key])
    );
}

export function createProviderError(input: {
  code: ProviderErrorCode;
  message: string;
  providerId: string;
  resourceId?: string;
  cause?: unknown;
}): ProviderError {
  const error = new Error(input.message, {
    cause: input.cause,
  }) as ProviderError;
  Object.defineProperties(error, {
    name: {
      configurable: true,
      value: "ProviderError",
      writable: true,
    },
    code: {
      enumerable: true,
      value: input.code,
    },
    providerId: {
      enumerable: true,
      value: input.providerId,
    },
    resourceId: {
      enumerable: input.resourceId !== undefined,
      value: input.resourceId,
    },
  });
  return error;
}

export function isProviderError(value: unknown): value is ProviderError {
  if (!(value instanceof Error)) return false;
  const candidate = value as Partial<ProviderError>;
  return candidate.name === "ProviderError" &&
    typeof candidate.code === "string" &&
    typeof candidate.providerId === "string";
}

export function throwIfProviderOperationAborted(
  signal: AbortSignal | undefined,
): void {
  signal?.throwIfAborted();
}

export function createProviderResource(input: {
  providerId: string;
  resourceId: string;
  identity: ProviderResource["identity"];
  createdAtMs: number;
  attributes?: JsonObject;
}): ProviderResource {
  const providerId = validateProviderId(input.providerId);
  const resourceId = validateProviderResourceId(input.resourceId);
  if (
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  ) {
    throw new TypeError("createdAtMs must be a non-negative safe integer");
  }

  return Object.freeze({
    providerId,
    resourceId,
    identity: Object.freeze(createWorkerIdentity(input.identity)),
    createdAtMs: input.createdAtMs,
    attributes: cloneProviderJsonObject(
      input.attributes ?? {},
      "$.attributes",
    ),
  });
}

export function assertProviderOwnsResource(
  providerId: string,
  resource: ProviderResource,
): ProviderResource {
  const expectedProviderId = validateProviderId(providerId);
  const validated = createProviderResource(resource);
  if (validated.providerId !== expectedProviderId) {
    throw createProviderError({
      code: "invalid_resource",
      message:
        `Provider ${expectedProviderId} cannot operate on resource ${validated.resourceId} owned by ${validated.providerId}`,
      providerId: expectedProviderId,
      resourceId: validated.resourceId,
    });
  }
  return validated;
}

export function assertProviderResourceMatches(
  providerId: string,
  suppliedResource: ProviderResource,
  storedResource: ProviderResource,
): ProviderResource {
  const supplied = assertProviderOwnsResource(
    providerId,
    suppliedResource,
  );
  const stored = assertProviderOwnsResource(providerId, storedResource);
  const matches = supplied.providerId === stored.providerId &&
    supplied.resourceId === stored.resourceId &&
    supplied.createdAtMs === stored.createdAtMs &&
    supplied.identity.workerId === stored.identity.workerId &&
    supplied.identity.attemptId === stored.identity.attemptId &&
    supplied.identity.epoch === stored.identity.epoch &&
    providerJsonEquals(supplied.attributes, stored.attributes);

  if (!matches) {
    throw createProviderError({
      code: "invalid_resource",
      message:
        `Provider resource ${supplied.resourceId} does not match its stored fenced reference`,
      providerId,
      resourceId: supplied.resourceId,
    });
  }
  return storedResource;
}

export function createProviderInspection(input: {
  resource: ProviderResource;
  state: ProviderResourceState;
  observedAtMs: number;
  details?: JsonObject;
}): ProviderInspection {
  if (!PROVIDER_RESOURCE_STATES.has(input.state)) {
    throw new TypeError(
      `Invalid provider resource state ${String(input.state)}`,
    );
  }
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
    throw new TypeError("observedAtMs must be a non-negative safe integer");
  }
  const resource = createProviderResource(input.resource);
  return Object.freeze({
    resource,
    state: input.state,
    observedAtMs: input.observedAtMs,
    details: cloneProviderJsonObject(input.details ?? {}, "$.details"),
  });
}

export function createProviderTermination(input: {
  resource: ProviderResource;
  outcome: ProviderTerminationOutcome;
  observedAtMs: number;
  details?: JsonObject;
}): ProviderTermination {
  if (!PROVIDER_TERMINATION_OUTCOMES.has(input.outcome)) {
    throw new TypeError(
      `Invalid provider termination outcome ${String(input.outcome)}`,
    );
  }
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
    throw new TypeError("observedAtMs must be a non-negative safe integer");
  }
  const resource = createProviderResource(input.resource);
  return Object.freeze({
    resource,
    outcome: input.outcome,
    observedAtMs: input.observedAtMs,
    details: cloneProviderJsonObject(input.details ?? {}, "$.details"),
  });
}
