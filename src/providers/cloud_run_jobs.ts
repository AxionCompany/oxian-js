import { createWorkerIdentity } from "../protocol/control.ts";
import type {
  JsonObject,
  JsonValue,
  WorkerIdentity,
} from "../protocol/types.ts";
import {
  assertProviderOwnsResource,
  cloneProviderJsonObject,
  createProviderError,
  createProviderInspection,
  createProviderResource,
  createProviderTermination,
  isProviderError,
  throwIfProviderOperationAborted,
  validateProviderId,
} from "./contract.ts";
import type {
  ProviderErrorCode,
  ProviderOperationOptions,
  ProviderResource,
  ProviderResourceState,
  WorkerProvider,
} from "./types.ts";

const CLOUD_RUN_API_ROOT = "https://run.googleapis.com/v2";
const DEFAULT_PROVIDER_ID = "google-cloud-run-jobs";
const MAX_ACCESS_TOKEN_LENGTH = 16_384;
const MAX_API_RESPONSE_LENGTH = 1_048_576;
const MAX_ARGUMENT_COUNT = 1_000;
const MAX_ARGUMENT_LENGTH = 32_768;
const MAX_ENVIRONMENT_COUNT = 1_000;
const MAX_ENVIRONMENT_VALUE_LENGTH = 32_768;
const MAX_EXECUTION_REASON_LENGTH = 512;
const MAX_EXECUTION_MESSAGE_LENGTH = 2_000;
const MAX_TIMEOUT_SECONDS = 604_800;
const CLOUD_RUN_JOB_ATTRIBUTE = "cloudRunJob";
const CLOUD_RUN_OPERATION_ATTRIBUTE = "cloudRunOperation";
const CLOUD_RUN_EXECUTION_ATTRIBUTE = "cloudRunExecution";

const SAFE_PROJECT_PATTERN =
  /^(?:[0-9]{1,20}|[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const CLOUD_RUN_SEGMENT_PATTERN = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLOUD_RUN_JOB_PATTERN = /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/;
const CLOUD_RUN_CONTAINER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CLOUD_RUN_OPERATION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const CLOUD_RUN_EXECUTION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type CloudRunJobsContainerOverride = Readonly<{
  name?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

export type CloudRunJobsLaunchSpec = Readonly<{
  /** The short Job ID in the provider's configured project and location. */
  job: string;
  containerOverride?: CloudRunJobsContainerOverride;
  timeoutSeconds?: number;
  attributes?: JsonObject;
}>;

export type CloudRunJobsProviderOptions = Readonly<{
  project: string;
  location: string;
  getAccessToken: (
    options?: ProviderOperationOptions,
  ) => string | Promise<string>;
  providerId?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}>;

/**
 * Durable Cloud Run names required to reconstruct one provider resource.
 *
 * Callers should normally persist the ProviderResource returned by provision.
 * This input exists for stores that retain provider-neutral fields separately,
 * and deliberately keeps Cloud Run's private provider attributes out of
 * application code.
 */
export type CloudRunJobsResourceInput = Readonly<{
  identity: WorkerIdentity;
  createdAtMs: number;
  job: string;
  operationName: string;
  executionName?: string;
  attributes?: JsonObject;
}>;

export type CloudRunJobsProvider =
  & WorkerProvider<CloudRunJobsLaunchSpec>
  & Readonly<{
    rehydrateResource(input: CloudRunJobsResourceInput): ProviderResource;
  }>;

type NormalizedContainerOverride = Readonly<{
  name?: string;
  args?: readonly string[];
  env?: readonly Readonly<{ name: string; value: string }>[];
}>;

type NormalizedLaunchSpec = Readonly<{
  jobName: string;
  body: JsonObject;
  attributes: JsonObject;
}>;

type CloudRunResourceReference = Readonly<{
  resource: ProviderResource;
  jobName: string;
  operationName: string;
  executionName?: string;
}>;

type ApiCallResult =
  | Readonly<{
    kind: "response";
    status: number;
    ok: boolean;
    body?: Record<string, unknown>;
    bodyFailure?: unknown;
  }>
  | Readonly<{
    kind: "transport_failure";
    cause: unknown;
  }>;

type ParsedOperation = Readonly<{
  name: string;
  done: boolean;
  hasError: boolean;
  executionName?: string;
}>;

type ParsedExecution = Readonly<{
  name: string;
  state: ProviderResourceState;
  details: JsonObject;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidLaunch(
  providerId: string,
  message: string,
  cause?: unknown,
): never {
  throw createProviderError({
    code: "invalid_launch_spec",
    message,
    providerId,
    cause,
  });
}

function readLaunchProperties(
  providerId: string,
  input: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    return invalidLaunch(
      providerId,
      `${label} must be a plain object`,
    );
  }
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return invalidLaunch(
        providerId,
        `${label} contains unsupported field ${String(key)}`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return invalidLaunch(
        providerId,
        `${label}.${key} must be an enumerable data property`,
      );
    }
    output[key] = descriptor.value;
  }
  return output;
}

function validateProject(project: unknown): string {
  if (
    typeof project !== "string" ||
    !SAFE_PROJECT_PATTERN.test(project)
  ) {
    throw new TypeError(
      "Cloud Run project must be a bounded project ID or number without path separators",
    );
  }
  return project;
}

function validateLocation(location: unknown): string {
  if (
    typeof location !== "string" ||
    !CLOUD_RUN_SEGMENT_PATTERN.test(location)
  ) {
    throw new TypeError(
      "Cloud Run location must be a lowercase resource segment",
    );
  }
  return location;
}

function validateJobId(
  providerId: string,
  job: unknown,
): string {
  if (typeof job !== "string" || !CLOUD_RUN_JOB_PATTERN.test(job)) {
    return invalidLaunch(
      providerId,
      "Cloud Run Job must be a lowercase resource segment of at most 49 characters",
    );
  }
  return job;
}

function validateContainerName(
  providerId: string,
  name: unknown,
): string {
  if (
    typeof name !== "string" ||
    !CLOUD_RUN_CONTAINER_PATTERN.test(name)
  ) {
    return invalidLaunch(
      providerId,
      "Cloud Run container override name must be a DNS label",
    );
  }
  return name;
}

function validateTimeoutSeconds(
  providerId: string,
  value: unknown,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_TIMEOUT_SECONDS
  ) {
    return invalidLaunch(
      providerId,
      `Cloud Run timeoutSeconds must be an integer from 1 through ${MAX_TIMEOUT_SECONDS}`,
    );
  }
  return value as number;
}

function validateNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      "Cloud Run provider now() must return a non-negative safe integer",
    );
  }
  return value;
}

function normalizeContainerOverride(
  providerId: string,
  input: unknown,
): NormalizedContainerOverride {
  const properties = readLaunchProperties(
    providerId,
    input,
    new Set(["name", "args", "env"]),
    "Cloud Run containerOverride",
  );

  const normalized: {
    name?: string;
    args?: readonly string[];
    env?: readonly Readonly<{ name: string; value: string }>[];
  } = {};

  if (properties.name !== undefined) {
    normalized.name = validateContainerName(providerId, properties.name);
  }

  if (properties.args !== undefined) {
    if (
      !Array.isArray(properties.args) ||
      properties.args.length > MAX_ARGUMENT_COUNT
    ) {
      return invalidLaunch(
        providerId,
        `Cloud Run container override args must contain at most ${MAX_ARGUMENT_COUNT} strings`,
      );
    }
    const args: string[] = [];
    for (let index = 0; index < properties.args.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(
        properties.args,
        String(index),
      );
      const value = descriptor?.value;
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof value !== "string" ||
        value.length > MAX_ARGUMENT_LENGTH ||
        value.includes("\0")
      ) {
        return invalidLaunch(
          providerId,
          `Cloud Run container override args must be strings of at most ${MAX_ARGUMENT_LENGTH} characters without null characters`,
        );
      }
      args.push(value);
    }
    for (const key of Reflect.ownKeys(properties.args)) {
      if (
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= properties.args.length)
      ) {
        return invalidLaunch(
          providerId,
          "Cloud Run container override args must not have extra properties",
        );
      }
    }
    normalized.args = Object.freeze(args);
  }

  if (properties.env !== undefined) {
    if (!isPlainObject(properties.env)) {
      return invalidLaunch(
        providerId,
        "Cloud Run container override env must be a plain string record",
      );
    }
    const keys = Reflect.ownKeys(properties.env);
    if (keys.length > MAX_ENVIRONMENT_COUNT) {
      return invalidLaunch(
        providerId,
        `Cloud Run container override env must contain at most ${MAX_ENVIRONMENT_COUNT} entries`,
      );
    }

    const environment: Readonly<{ name: string; value: string }>[] = [];
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        !ENVIRONMENT_NAME_PATTERN.test(key)
      ) {
        return invalidLaunch(
          providerId,
          `Invalid Cloud Run environment variable name ${JSON.stringify(key)}`,
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(properties.env, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "string" ||
        descriptor.value.length > MAX_ENVIRONMENT_VALUE_LENGTH ||
        descriptor.value.includes("\0")
      ) {
        return invalidLaunch(
          providerId,
          `Cloud Run environment variable ${key} must be an enumerable string of at most ${MAX_ENVIRONMENT_VALUE_LENGTH} characters without null characters`,
        );
      }
      environment.push(Object.freeze({
        name: key,
        value: descriptor.value,
      }));
    }
    normalized.env = Object.freeze(environment);
  }

  return Object.freeze(normalized);
}

function withoutProviderAttributes(attributes: JsonObject): JsonObject {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      key !== CLOUD_RUN_JOB_ATTRIBUTE &&
      key !== CLOUD_RUN_OPERATION_ATTRIBUTE &&
      key !== CLOUD_RUN_EXECUTION_ATTRIBUTE
    ) {
      output[key] = value;
    }
  }
  return Object.freeze(output);
}

function normalizeLaunchSpec(
  providerId: string,
  project: string,
  location: string,
  input: unknown,
): NormalizedLaunchSpec {
  const properties = readLaunchProperties(
    providerId,
    input,
    new Set([
      "job",
      "containerOverride",
      "timeoutSeconds",
      "attributes",
    ]),
    "Cloud Run Jobs launch spec",
  );
  const job = validateJobId(providerId, properties.job);
  const jobName = `projects/${project}/locations/${location}/jobs/${job}`;
  const overrides: Record<string, JsonValue> = {
    taskCount: 1,
  };

  if (properties.containerOverride !== undefined) {
    const container = normalizeContainerOverride(
      providerId,
      properties.containerOverride,
    );
    const wireContainer: Record<string, JsonValue> = {};
    if (container.name !== undefined) wireContainer.name = container.name;
    if (container.args !== undefined) {
      if (container.args.length === 0) {
        wireContainer.clearArgs = true;
      } else {
        wireContainer.args = container.args;
      }
    }
    if (container.env !== undefined) wireContainer.env = container.env;
    overrides.containerOverrides = Object.freeze([
      Object.freeze(wireContainer),
    ]);
  }
  if (properties.timeoutSeconds !== undefined) {
    const timeoutSeconds = validateTimeoutSeconds(
      providerId,
      properties.timeoutSeconds,
    );
    overrides.timeout = `${timeoutSeconds}s`;
  }

  let attributes: JsonObject;
  try {
    attributes = withoutProviderAttributes(
      cloneProviderJsonObject(
        properties.attributes === undefined ? {} : properties.attributes,
        "$.launch.attributes",
      ),
    );
  } catch (cause) {
    return invalidLaunch(
      providerId,
      "Cloud Run Jobs attributes must be a valid JSON object",
      cause,
    );
  }

  return Object.freeze({
    jobName,
    body: Object.freeze({
      overrides: Object.freeze(overrides),
    }),
    attributes,
  });
}

function validateAccessToken(
  providerId: string,
  token: unknown,
  errorCode: ProviderErrorCode,
): string {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_ACCESS_TOKEN_LENGTH ||
    [...token].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code >= 0x7f;
    })
  ) {
    throw createProviderError({
      code: errorCode,
      message: "Cloud Run access token provider returned an invalid token",
      providerId,
    });
  }
  return token;
}

async function acquireAccessToken(
  providerId: string,
  getAccessToken: CloudRunJobsProviderOptions["getAccessToken"],
  operationOptions: ProviderOperationOptions | undefined,
  errorCode: ProviderErrorCode,
): Promise<string> {
  let token: unknown;
  try {
    token = await getAccessToken(
      Object.freeze({ signal: operationOptions?.signal }),
    );
  } catch (cause) {
    if (operationOptions?.signal?.aborted) {
      operationOptions.signal.throwIfAborted();
    }
    throw createProviderError({
      code: errorCode,
      message: "Failed to acquire a Cloud Run access token",
      providerId,
      cause,
    });
  }
  throwIfProviderOperationAborted(operationOptions?.signal);
  return validateAccessToken(providerId, token, errorCode);
}

async function callApi(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<ApiCallResult> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      // Following a 307/308 would replay a mutating request. Providers issue
      // each lifecycle mutation exactly once and surface redirects as
      // indeterminate instead.
      redirect: "error",
    });
  } catch (cause) {
    return Object.freeze({
      kind: "transport_failure",
      cause,
    });
  }

  let text: string;
  try {
    text = await readBoundedResponseText(response);
  } catch (bodyFailure) {
    return Object.freeze({
      kind: "response",
      status: response.status,
      ok: response.ok,
      bodyFailure,
    });
  }
  if (text.length === 0) {
    return Object.freeze({
      kind: "response",
      status: response.status,
      ok: response.ok,
      body: {},
    });
  }

  try {
    const body: unknown = JSON.parse(text);
    if (!isPlainObject(body)) {
      throw new TypeError("Cloud Run API response must be a JSON object");
    }
    return Object.freeze({
      kind: "response",
      status: response.status,
      ok: response.ok,
      body,
    });
  } catch (bodyFailure) {
    return Object.freeze({
      kind: "response",
      status: response.status,
      ok: response.ok,
      bodyFailure,
    });
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      size += next.value.byteLength;
      if (size > MAX_API_RESPONSE_LENGTH) {
        await reader.cancel(
          new TypeError("Cloud Run API response exceeded its limit"),
        );
        throw new TypeError("Cloud Run API response exceeded its limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function requestHeaders(token: string, includeBody: boolean): HeadersInit {
  return includeBody
    ? {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    }
    : {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
}

function apiFailureMessage(
  operation: string,
  result: Extract<ApiCallResult, { kind: "response" }>,
): string {
  let detail: string | undefined;
  const nested = result.body?.error;
  if (isPlainObject(nested) && typeof nested.message === "string") {
    detail = [...nested.message].map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : character;
    }).join("").slice(0, 512);
  }
  return detail
    ? `Cloud Run API ${operation} failed (${result.status}): ${detail}`
    : `Cloud Run API ${operation} failed (${result.status})`;
}

function isAmbiguousProvisionStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function throwIfReadAborted(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) signal.throwIfAborted();
}

function operationPrefix(project: string, location: string): string {
  return `projects/${project}/locations/${location}/operations/`;
}

function validateOperationName(
  project: string,
  location: string,
  value: unknown,
): string {
  const prefix = operationPrefix(project, location);
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !CLOUD_RUN_OPERATION_ID_PATTERN.test(value.slice(prefix.length))
  ) {
    throw new TypeError(
      "Cloud Run operation does not belong to the configured project and location",
    );
  }
  return value;
}

function validateExecutionName(
  jobName: string,
  value: unknown,
): string {
  const prefix = `${jobName}/executions/`;
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !CLOUD_RUN_EXECUTION_ID_PATTERN.test(value.slice(prefix.length))
  ) {
    throw new TypeError(
      "Cloud Run execution does not belong to the expected Job",
    );
  }
  return value;
}

function optionalExecutionName(
  jobName: string,
  container: unknown,
): string | undefined {
  if (container === undefined) return undefined;
  if (!isPlainObject(container)) {
    throw new TypeError("Cloud Run operation payload is malformed");
  }
  if (container.name === undefined) return undefined;
  return validateExecutionName(jobName, container.name);
}

function parseOperation(
  project: string,
  location: string,
  jobName: string,
  body: unknown,
  expectedName?: string,
): ParsedOperation {
  if (!isPlainObject(body)) {
    throw new TypeError("Cloud Run operation must be a JSON object");
  }
  const name = validateOperationName(project, location, body.name);
  if (expectedName !== undefined && name !== expectedName) {
    throw new TypeError("Cloud Run returned a different operation");
  }
  if (body.done !== undefined && typeof body.done !== "boolean") {
    throw new TypeError("Cloud Run operation done field is malformed");
  }
  const hasError = Object.hasOwn(body, "error");
  const hasResponse = Object.hasOwn(body, "response");
  if (hasError && (!isPlainObject(body.error) || hasResponse)) {
    throw new TypeError("Cloud Run operation result is malformed");
  }
  if (hasResponse && !isPlainObject(body.response)) {
    throw new TypeError("Cloud Run operation response is malformed");
  }
  if ((hasError || hasResponse) && body.done !== true) {
    throw new TypeError(
      "Cloud Run operation cannot have a result before completion",
    );
  }
  if (body.done === true && !hasError && !hasResponse) {
    throw new TypeError(
      "Completed Cloud Run operation must have exactly one result",
    );
  }

  const metadataExecution = optionalExecutionName(
    jobName,
    body.metadata,
  );
  const responseExecution = optionalExecutionName(
    jobName,
    body.response,
  );
  if (
    metadataExecution !== undefined &&
    responseExecution !== undefined &&
    metadataExecution !== responseExecution
  ) {
    throw new TypeError(
      "Cloud Run operation named conflicting executions",
    );
  }

  return Object.freeze({
    name,
    done: body.done === true,
    hasError,
    executionName: responseExecution ?? metadataExecution,
  });
}

function optionalNonNegativeInteger(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Cloud Run execution ${field} is malformed`);
  }
  return value as number;
}

function optionalTimestamp(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`Cloud Run execution ${field} is malformed`);
  }
  return value;
}

function optionalDiagnostic(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Cloud Run execution condition ${field} is malformed`);
  }
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("").slice(0, maxLength);
}

function parseExecution(
  jobName: string,
  body: unknown,
  expectedName: string,
): ParsedExecution {
  if (!isPlainObject(body)) {
    throw new TypeError("Cloud Run execution must be a JSON object");
  }
  const name = validateExecutionName(jobName, body.name);
  if (name !== expectedName) {
    throw new TypeError("Cloud Run returned a different execution");
  }
  const jobId = jobName.slice(jobName.lastIndexOf("/") + 1);
  if (
    body.job !== undefined &&
    body.job !== jobName &&
    body.job !== jobId
  ) {
    throw new TypeError("Cloud Run execution named a different Job");
  }
  if (
    body.reconciling !== undefined &&
    typeof body.reconciling !== "boolean"
  ) {
    throw new TypeError(
      "Cloud Run execution reconciling field is malformed",
    );
  }

  const taskCount = optionalNonNegativeInteger(body, "taskCount");
  if (taskCount !== undefined && taskCount !== 1) {
    throw new TypeError(
      "Cloud Run execution violated the provider taskCount attestation",
    );
  }
  const runningCount = optionalNonNegativeInteger(body, "runningCount");
  const succeededCount = optionalNonNegativeInteger(body, "succeededCount");
  const failedCount = optionalNonNegativeInteger(body, "failedCount");
  const cancelledCount = optionalNonNegativeInteger(body, "cancelledCount");
  for (
    const [field, count] of [
      ["runningCount", runningCount],
      ["succeededCount", succeededCount],
      ["failedCount", failedCount],
      ["cancelledCount", cancelledCount],
    ] as const
  ) {
    if (count !== undefined && count > 1) {
      throw new TypeError(
        `Cloud Run execution ${field} exceeds forced taskCount 1`,
      );
    }
  }
  if (
    (runningCount ?? 0) +
        (succeededCount ?? 0) +
        (failedCount ?? 0) +
        (cancelledCount ?? 0) >
      1
  ) {
    throw new TypeError(
      "Cloud Run execution task phase counts are inconsistent",
    );
  }
  const completionTime = optionalTimestamp(body, "completionTime");
  const deleteTime = optionalTimestamp(body, "deleteTime");

  let conditionFailed = false;
  let conditionSucceeded = false;
  let terminalReason: string | undefined;
  let terminalMessage: string | undefined;
  if (body.conditions !== undefined) {
    if (!Array.isArray(body.conditions)) {
      throw new TypeError("Cloud Run execution conditions are malformed");
    }
    for (const condition of body.conditions) {
      if (!isPlainObject(condition)) {
        throw new TypeError("Cloud Run execution condition is malformed");
      }
      if (
        condition.type !== undefined &&
        typeof condition.type !== "string"
      ) {
        throw new TypeError(
          "Cloud Run execution condition type is malformed",
        );
      }
      if (
        condition.state !== undefined &&
        typeof condition.state !== "string"
      ) {
        throw new TypeError(
          "Cloud Run execution condition state is malformed",
        );
      }
      const reason = optionalDiagnostic(
        condition,
        "reason",
        MAX_EXECUTION_REASON_LENGTH,
      );
      const message = optionalDiagnostic(
        condition,
        "message",
        MAX_EXECUTION_MESSAGE_LENGTH,
      );
      if (condition.state === "CONDITION_FAILED") {
        conditionFailed = true;
        terminalReason ??= reason;
        terminalMessage ??= message;
      }
      if (
        condition.type === "Completed" &&
        condition.state === "CONDITION_SUCCEEDED"
      ) {
        conditionSucceeded = true;
        terminalReason ??= reason;
        terminalMessage ??= message;
      }
    }
  }

  let state: ProviderResourceState = "present";
  let phase = "active";
  if (
    cancelledCount !== undefined && cancelledCount > 0
  ) {
    state = "absent";
    phase = "cancelled";
  } else if (failedCount !== undefined && failedCount > 0 || conditionFailed) {
    state = "failed";
    phase = "failed";
  } else if (
    deleteTime !== undefined ||
    completionTime !== undefined ||
    succeededCount !== undefined && succeededCount >= 1 ||
    conditionSucceeded
  ) {
    state = "absent";
    phase = "completed";
  }

  const details: Record<string, JsonValue> = {
    executionName: name,
    phase,
  };
  if (runningCount !== undefined) details.runningCount = runningCount;
  if (succeededCount !== undefined) details.succeededCount = succeededCount;
  if (failedCount !== undefined) details.failedCount = failedCount;
  if (cancelledCount !== undefined) details.cancelledCount = cancelledCount;
  if (terminalReason !== undefined) details.reason = terminalReason;
  if (terminalMessage !== undefined) details.message = terminalMessage;

  return Object.freeze({
    name,
    state,
    details: Object.freeze(details),
  });
}

function invalidResource(
  providerId: string,
  resourceId: string | undefined,
  message: string,
  cause?: unknown,
): never {
  throw createProviderError({
    code: "invalid_resource",
    message,
    providerId,
    resourceId,
    cause,
  });
}

function parseResourceReference(
  providerId: string,
  project: string,
  location: string,
  resourceInput: ProviderResource,
): CloudRunResourceReference {
  let resource: ProviderResource;
  try {
    resource = assertProviderOwnsResource(providerId, resourceInput);
  } catch (cause) {
    if (isProviderError(cause)) throw cause;
    return invalidResource(
      providerId,
      typeof resourceInput?.resourceId === "string"
        ? resourceInput.resourceId
        : undefined,
      "Cloud Run provider resource is malformed",
      cause,
    );
  }

  try {
    const operationName = validateOperationName(
      project,
      location,
      resource.resourceId,
    );
    if (
      resource.attributes[CLOUD_RUN_OPERATION_ATTRIBUTE] !== operationName
    ) {
      return invalidResource(
        providerId,
        operationName,
        "Cloud Run provider resource operation attribute is missing or inconsistent",
      );
    }

    const jobName = resource.attributes[CLOUD_RUN_JOB_ATTRIBUTE];
    if (typeof jobName !== "string") {
      return invalidResource(
        providerId,
        operationName,
        "Cloud Run provider resource Job attribute is missing",
      );
    }
    const configuredJobPrefix =
      `projects/${project}/locations/${location}/jobs/`;
    if (
      !jobName.startsWith(configuredJobPrefix) ||
      !CLOUD_RUN_JOB_PATTERN.test(
        jobName.slice(configuredJobPrefix.length),
      )
    ) {
      return invalidResource(
        providerId,
        operationName,
        "Cloud Run provider resource Job is outside the configured scope",
      );
    }

    const executionAttribute =
      resource.attributes[CLOUD_RUN_EXECUTION_ATTRIBUTE];
    const executionName = executionAttribute === undefined
      ? undefined
      : validateExecutionName(jobName, executionAttribute);

    return Object.freeze({
      resource,
      jobName,
      operationName,
      executionName,
    });
  } catch (cause) {
    if (isProviderError(cause)) throw cause;
    return invalidResource(
      providerId,
      resource.resourceId,
      "Cloud Run provider resource attributes are malformed",
      cause,
    );
  }
}

function rehydrateCloudRunJobsResource(
  providerId: string,
  project: string,
  location: string,
  input: CloudRunJobsResourceInput,
): ProviderResource {
  if (!isPlainObject(input)) {
    return invalidResource(
      providerId,
      undefined,
      "Cloud Run resource rehydration input must be a plain object",
    );
  }
  const allowed = new Set([
    "identity",
    "createdAtMs",
    "job",
    "operationName",
    "executionName",
    "attributes",
  ]);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = typeof key === "string"
      ? Object.getOwnPropertyDescriptor(input, key)
      : undefined;
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      return invalidResource(
        providerId,
        typeof input.operationName === "string"
          ? input.operationName
          : undefined,
        `Cloud Run resource rehydration input contains unsupported field ${
          String(key)
        }`,
      );
    }
  }

  try {
    if (
      typeof input.job !== "string" ||
      !CLOUD_RUN_JOB_PATTERN.test(input.job)
    ) {
      throw new TypeError(
        "Cloud Run Job must be a lowercase resource segment of at most 49 characters",
      );
    }
    const jobName =
      `projects/${project}/locations/${location}/jobs/${input.job}`;
    const operationName = validateOperationName(
      project,
      location,
      input.operationName,
    );
    const executionName = input.executionName === undefined
      ? undefined
      : validateExecutionName(jobName, input.executionName);
    const callerAttributes = withoutProviderAttributes(
      cloneProviderJsonObject(
        input.attributes ?? {},
        "$.resource.attributes",
      ),
    );
    return createProviderResource({
      providerId,
      resourceId: operationName,
      identity: input.identity,
      createdAtMs: input.createdAtMs,
      attributes: Object.freeze({
        ...callerAttributes,
        [CLOUD_RUN_JOB_ATTRIBUTE]: jobName,
        [CLOUD_RUN_OPERATION_ATTRIBUTE]: operationName,
        ...(executionName === undefined
          ? {}
          : { [CLOUD_RUN_EXECUTION_ATTRIBUTE]: executionName }),
      }),
    });
  } catch (cause) {
    if (isProviderError(cause)) throw cause;
    return invalidResource(
      providerId,
      typeof input.operationName === "string" ? input.operationName : undefined,
      "Cloud Run resource rehydration input is malformed",
      cause,
    );
  }
}

function operationDetails(
  reference: CloudRunResourceReference,
  input: Readonly<{
    phase: string;
    executionName?: string;
    cancellationOperation?: string;
  }>,
): JsonObject {
  return Object.freeze({
    jobName: reference.jobName,
    operationName: reference.operationName,
    phase: input.phase,
    ...(input.executionName === undefined
      ? {}
      : { executionName: input.executionName }),
    ...(input.cancellationOperation === undefined
      ? {}
      : { cancellationOperation: input.cancellationOperation }),
  });
}

function providerFailure(
  providerId: string,
  resourceId: string | undefined,
  code: ProviderErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw createProviderError({
    code,
    message,
    providerId,
    resourceId,
    cause,
  });
}

function assertSameExecution(
  storedExecutionName: string | undefined,
  observedExecutionName: string | undefined,
): string | undefined {
  if (
    storedExecutionName !== undefined &&
    observedExecutionName !== undefined &&
    storedExecutionName !== observedExecutionName
  ) {
    throw new TypeError(
      "Cloud Run operation no longer identifies the provisioned execution",
    );
  }
  return observedExecutionName ?? storedExecutionName;
}

function createExecutionMissingInspection(
  reference: CloudRunResourceReference,
  observedAtMs: number,
) {
  return createProviderInspection({
    resource: reference.resource,
    state: "absent",
    observedAtMs,
    details: operationDetails(reference, {
      phase: "execution_absent",
      executionName: reference.executionName,
    }),
  });
}

function createAlreadyAbsentTermination(
  reference: CloudRunResourceReference,
  observedAtMs: number,
  phase: string,
  executionName?: string,
) {
  return createProviderTermination({
    resource: reference.resource,
    outcome: "already_absent",
    observedAtMs,
    details: operationDetails(reference, {
      phase,
      executionName,
    }),
  });
}

/**
 * Creates a stateless Cloud Run Jobs provider.
 *
 * A resource stores only canonical provider resource names and caller-owned
 * JSON attributes. Access tokens, URLs, worker-session state, and launch
 * overrides never become durable provider attributes.
 */
export function createCloudRunJobsProvider(
  options: CloudRunJobsProviderOptions,
): CloudRunJobsProvider {
  if (!isPlainObject(options)) {
    throw new TypeError("Cloud Run Jobs provider options are required");
  }
  const providerId = validateProviderId(
    options.providerId ?? DEFAULT_PROVIDER_ID,
  );
  const project = validateProject(options.project);
  const location = validateLocation(options.location);
  if (typeof options.getAccessToken !== "function") {
    throw new TypeError(
      "Cloud Run Jobs provider getAccessToken must be a function",
    );
  }
  if (options.fetcher !== undefined && typeof options.fetcher !== "function") {
    throw new TypeError("Cloud Run Jobs provider fetcher must be a function");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("Cloud Run Jobs provider now must be a function");
  }
  const getAccessToken = options.getAccessToken;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;

  return Object.freeze({
    providerId,

    rehydrateResource(input) {
      return rehydrateCloudRunJobsResource(
        providerId,
        project,
        location,
        input,
      );
    },

    async provision(request, operationOptions) {
      throwIfProviderOperationAborted(operationOptions?.signal);

      // Every caller-controlled value is validated and copied before auth or
      // network I/O. In particular, a rejected launch cannot consume a token.
      const identity: WorkerIdentity = Object.freeze(
        createWorkerIdentity(request.identity),
      );
      const launch = normalizeLaunchSpec(
        providerId,
        project,
        location,
        request.launch,
      );
      const createdAtMs = validateNow(now);
      const token = await acquireAccessToken(
        providerId,
        getAccessToken,
        operationOptions,
        "provision_failed",
      );

      throwIfProviderOperationAborted(operationOptions?.signal);
      const result = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${launch.jobName}:run`,
        {
          method: "POST",
          headers: requestHeaders(token, true),
          body: JSON.stringify(launch.body),
          signal: operationOptions?.signal,
        },
      );
      if (result.kind === "transport_failure") {
        return providerFailure(
          providerId,
          undefined,
          "provision_indeterminate",
          `Cloud Run Job ${launch.jobName} launch outcome is indeterminate`,
          result.cause,
        );
      }
      if (!result.ok) {
        const code: ProviderErrorCode = result.status === 409
          ? "conflict"
          : isAmbiguousProvisionStatus(result.status)
          ? "provision_indeterminate"
          : "provision_failed";
        return providerFailure(
          providerId,
          undefined,
          code,
          apiFailureMessage("Job launch", result),
          result.bodyFailure,
        );
      }
      if (result.bodyFailure !== undefined || result.body === undefined) {
        return providerFailure(
          providerId,
          undefined,
          "provision_indeterminate",
          `Cloud Run Job ${launch.jobName} accepted a launch but returned an unreadable operation`,
          result.bodyFailure,
        );
      }

      let operation: ParsedOperation;
      try {
        operation = parseOperation(
          project,
          location,
          launch.jobName,
          result.body,
        );
      } catch (cause) {
        return providerFailure(
          providerId,
          undefined,
          "provision_indeterminate",
          `Cloud Run Job ${launch.jobName} accepted a launch but returned an invalid operation`,
          cause,
        );
      }
      if (operation.hasError) {
        return providerFailure(
          providerId,
          operation.name,
          "provision_failed",
          `Cloud Run Job ${launch.jobName} launch operation failed`,
        );
      }

      const resourceAttributes: Record<string, JsonValue> = {
        ...launch.attributes,
        [CLOUD_RUN_JOB_ATTRIBUTE]: launch.jobName,
        [CLOUD_RUN_OPERATION_ATTRIBUTE]: operation.name,
      };
      if (operation.executionName !== undefined) {
        resourceAttributes[CLOUD_RUN_EXECUTION_ATTRIBUTE] =
          operation.executionName;
      }
      return createProviderResource({
        providerId,
        resourceId: operation.name,
        identity,
        createdAtMs,
        attributes: Object.freeze(resourceAttributes),
      });
    },

    async inspect(resourceInput, operationOptions) {
      throwIfProviderOperationAborted(operationOptions?.signal);
      const reference = parseResourceReference(
        providerId,
        project,
        location,
        resourceInput,
      );
      const observedAtMs = validateNow(now);
      const token = await acquireAccessToken(
        providerId,
        getAccessToken,
        operationOptions,
        "inspection_failed",
      );

      const operationResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${reference.operationName}`,
        {
          method: "GET",
          headers: requestHeaders(token, false),
          signal: operationOptions?.signal,
        },
      );
      throwIfReadAborted(operationOptions?.signal);
      if (operationResult.kind === "transport_failure") {
        return providerFailure(
          providerId,
          reference.operationName,
          "inspection_failed",
          `Failed to inspect Cloud Run operation ${reference.operationName}`,
          operationResult.cause,
        );
      }

      let executionName = reference.executionName;
      let operationPending = false;
      let operationFailed = false;
      if (operationResult.status === 404) {
        if (executionName === undefined) {
          return createProviderInspection({
            resource: reference.resource,
            state: "unknown",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "operation_absent",
            }),
          });
        }
      } else {
        if (!operationResult.ok) {
          return providerFailure(
            providerId,
            reference.operationName,
            "inspection_failed",
            apiFailureMessage("operation inspection", operationResult),
            operationResult.bodyFailure,
          );
        }
        if (
          operationResult.bodyFailure !== undefined ||
          operationResult.body === undefined
        ) {
          return providerFailure(
            providerId,
            reference.operationName,
            "inspection_failed",
            "Cloud Run operation inspection returned an unreadable response",
            operationResult.bodyFailure,
          );
        }

        let operation: ParsedOperation;
        try {
          operation = parseOperation(
            project,
            location,
            reference.jobName,
            operationResult.body,
            reference.operationName,
          );
          executionName = assertSameExecution(
            reference.executionName,
            operation.executionName,
          );
          operationPending = !operation.done;
          operationFailed = operation.hasError;
        } catch (cause) {
          return providerFailure(
            providerId,
            reference.operationName,
            "inspection_failed",
            "Cloud Run operation inspection returned inconsistent state",
            cause,
          );
        }
        if (operation.hasError && executionName === undefined) {
          return createProviderInspection({
            resource: reference.resource,
            state: "failed",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "operation_failed",
              executionName,
            }),
          });
        }
        if (executionName === undefined) {
          if (operation.done) {
            return providerFailure(
              providerId,
              reference.operationName,
              "inspection_failed",
              "Completed Cloud Run operation did not identify its execution",
            );
          }
          return createProviderInspection({
            resource: reference.resource,
            state: "present",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "provisioning",
            }),
          });
        }
      }

      const executionResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${executionName}`,
        {
          method: "GET",
          headers: requestHeaders(token, false),
          signal: operationOptions?.signal,
        },
      );
      throwIfReadAborted(operationOptions?.signal);
      if (executionResult.kind === "transport_failure") {
        return providerFailure(
          providerId,
          reference.operationName,
          "inspection_failed",
          `Failed to inspect Cloud Run execution ${executionName}`,
          executionResult.cause,
        );
      }
      if (executionResult.status === 404) {
        if (operationPending) {
          return createProviderInspection({
            resource: reference.resource,
            state: "present",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "provisioning",
              executionName,
            }),
          });
        }
        if (operationFailed) {
          return createProviderInspection({
            resource: reference.resource,
            state: "failed",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "operation_failed",
              executionName,
            }),
          });
        }
        return createExecutionMissingInspection(
          Object.freeze({ ...reference, executionName }),
          observedAtMs,
        );
      }
      if (!executionResult.ok) {
        return providerFailure(
          providerId,
          reference.operationName,
          "inspection_failed",
          apiFailureMessage("execution inspection", executionResult),
          executionResult.bodyFailure,
        );
      }
      if (
        executionResult.bodyFailure !== undefined ||
        executionResult.body === undefined
      ) {
        return providerFailure(
          providerId,
          reference.operationName,
          "inspection_failed",
          "Cloud Run execution inspection returned an unreadable response",
          executionResult.bodyFailure,
        );
      }

      let execution: ParsedExecution;
      try {
        execution = parseExecution(
          reference.jobName,
          executionResult.body,
          executionName,
        );
      } catch (cause) {
        return providerFailure(
          providerId,
          reference.operationName,
          "inspection_failed",
          "Cloud Run execution inspection returned inconsistent state",
          cause,
        );
      }
      return createProviderInspection({
        resource: reference.resource,
        state: execution.state,
        observedAtMs,
        details: Object.freeze({
          ...operationDetails(reference, {
            phase: String(execution.details.phase),
            executionName,
          }),
          ...execution.details,
        }),
      });
    },

    async terminate(resourceInput, operationOptions) {
      throwIfProviderOperationAborted(operationOptions?.signal);
      const reference = parseResourceReference(
        providerId,
        project,
        location,
        resourceInput,
      );
      if (
        operationOptions?.gracePeriodMs !== undefined &&
        (!Number.isSafeInteger(operationOptions.gracePeriodMs) ||
          operationOptions.gracePeriodMs < 0)
      ) {
        throw new TypeError(
          "gracePeriodMs must be a non-negative safe integer",
        );
      }
      // Cloud Run Jobs exposes cancellation, not a separate graceful-signal
      // phase. The provider-neutral grace window is therefore only a validated
      // hint here; the worker protocol should drain before provider teardown.
      const observedAtMs = validateNow(now);
      const token = await acquireAccessToken(
        providerId,
        getAccessToken,
        operationOptions,
        "termination_failed",
      );

      const operationResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${reference.operationName}`,
        {
          method: "GET",
          headers: requestHeaders(token, false),
          signal: operationOptions?.signal,
        },
      );
      throwIfReadAborted(operationOptions?.signal);
      if (operationResult.kind === "transport_failure") {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          `Failed to resolve Cloud Run operation ${reference.operationName} before termination`,
          operationResult.cause,
        );
      }

      let executionName = reference.executionName;
      let operationPending = false;
      if (operationResult.status === 404) {
        if (executionName === undefined) {
          return createProviderTermination({
            resource: reference.resource,
            outcome: "unknown",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "operation_absent",
            }),
          });
        }
      } else {
        if (!operationResult.ok) {
          return providerFailure(
            providerId,
            reference.operationName,
            "termination_failed",
            apiFailureMessage("operation resolution", operationResult),
            operationResult.bodyFailure,
          );
        }
        if (
          operationResult.bodyFailure !== undefined ||
          operationResult.body === undefined
        ) {
          return providerFailure(
            providerId,
            reference.operationName,
            "termination_failed",
            "Cloud Run operation resolution returned an unreadable response",
            operationResult.bodyFailure,
          );
        }

        let operation: ParsedOperation;
        try {
          operation = parseOperation(
            project,
            location,
            reference.jobName,
            operationResult.body,
            reference.operationName,
          );
          executionName = assertSameExecution(
            reference.executionName,
            operation.executionName,
          );
          operationPending = !operation.done;
        } catch (cause) {
          return providerFailure(
            providerId,
            reference.operationName,
            "termination_failed",
            "Cloud Run operation resolution returned inconsistent state",
            cause,
          );
        }
        if (operation.hasError && executionName === undefined) {
          return createAlreadyAbsentTermination(
            reference,
            observedAtMs,
            "operation_failed",
            executionName,
          );
        }
        if (executionName === undefined) {
          return createProviderTermination({
            resource: reference.resource,
            outcome: "unknown",
            observedAtMs,
            details: operationDetails(reference, {
              phase: operation.done ? "execution_unresolved" : "provisioning",
            }),
          });
        }
      }

      const executionResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${executionName}`,
        {
          method: "GET",
          headers: requestHeaders(token, false),
          signal: operationOptions?.signal,
        },
      );
      throwIfReadAborted(operationOptions?.signal);
      if (executionResult.kind === "transport_failure") {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          `Failed to inspect Cloud Run execution ${executionName} before termination`,
          executionResult.cause,
        );
      }
      if (executionResult.status === 404) {
        if (operationPending) {
          return createProviderTermination({
            resource: reference.resource,
            outcome: "unknown",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "provisioning",
              executionName,
            }),
          });
        }
        return createAlreadyAbsentTermination(
          reference,
          observedAtMs,
          "execution_absent",
          executionName,
        );
      }
      if (!executionResult.ok) {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          apiFailureMessage("execution resolution", executionResult),
          executionResult.bodyFailure,
        );
      }
      if (
        executionResult.bodyFailure !== undefined ||
        executionResult.body === undefined
      ) {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          "Cloud Run execution resolution returned an unreadable response",
          executionResult.bodyFailure,
        );
      }

      let execution: ParsedExecution;
      try {
        execution = parseExecution(
          reference.jobName,
          executionResult.body,
          executionName,
        );
      } catch (cause) {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          "Cloud Run execution resolution returned inconsistent state",
          cause,
        );
      }
      if (execution.state !== "present") {
        return createAlreadyAbsentTermination(
          reference,
          observedAtMs,
          String(execution.details.phase),
          executionName,
        );
      }

      throwIfProviderOperationAborted(operationOptions?.signal);
      const cancellationResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${executionName}:cancel`,
        {
          method: "POST",
          headers: requestHeaders(token, true),
          body: "{}",
          signal: operationOptions?.signal,
        },
      );
      if (cancellationResult.kind === "transport_failure") {
        return createProviderTermination({
          resource: reference.resource,
          outcome: "unknown",
          observedAtMs,
          details: operationDetails(reference, {
            phase: "cancellation_indeterminate",
            executionName,
          }),
        });
      }
      if (cancellationResult.status === 404) {
        return createAlreadyAbsentTermination(
          reference,
          observedAtMs,
          "execution_absent",
          executionName,
        );
      }
      if (!cancellationResult.ok) {
        if (isAmbiguousProvisionStatus(cancellationResult.status)) {
          return createProviderTermination({
            resource: reference.resource,
            outcome: "unknown",
            observedAtMs,
            details: operationDetails(reference, {
              phase: "cancellation_indeterminate",
              executionName,
            }),
          });
        }
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          apiFailureMessage("execution cancellation", cancellationResult),
          cancellationResult.bodyFailure,
        );
      }
      if (
        cancellationResult.bodyFailure !== undefined ||
        cancellationResult.body === undefined
      ) {
        return createProviderTermination({
          resource: reference.resource,
          outcome: "unknown",
          observedAtMs,
          details: operationDetails(reference, {
            phase: "cancellation_indeterminate",
            executionName,
          }),
        });
      }

      let cancellation: ParsedOperation;
      try {
        cancellation = parseOperation(
          project,
          location,
          reference.jobName,
          cancellationResult.body,
        );
        assertSameExecution(
          executionName,
          cancellation.executionName,
        );
      } catch {
        return createProviderTermination({
          resource: reference.resource,
          outcome: "unknown",
          observedAtMs,
          details: operationDetails(reference, {
            phase: "cancellation_indeterminate",
            executionName,
          }),
        });
      }
      if (cancellation.hasError) {
        return providerFailure(
          providerId,
          reference.operationName,
          "termination_failed",
          `Cloud Run cancellation operation ${cancellation.name} failed`,
        );
      }

      // A successful cancel response only acknowledges another LRO. Perform
      // one exact read to confirm that compute is terminal; never call a
      // pending cancellation "terminated" and never poll or replay it.
      const confirmationResult = await callApi(
        fetcher,
        `${CLOUD_RUN_API_ROOT}/${executionName}`,
        {
          method: "GET",
          headers: requestHeaders(token, false),
          signal: operationOptions?.signal,
        },
      );
      if (
        confirmationResult.kind === "response" &&
        confirmationResult.status === 404
      ) {
        return createProviderTermination({
          resource: reference.resource,
          outcome: "terminated",
          observedAtMs,
          details: operationDetails(reference, {
            phase: "execution_absent",
            executionName,
            cancellationOperation: cancellation.name,
          }),
        });
      }
      if (
        confirmationResult.kind === "response" &&
        confirmationResult.ok &&
        confirmationResult.bodyFailure === undefined &&
        confirmationResult.body !== undefined
      ) {
        try {
          const confirmedExecution = parseExecution(
            reference.jobName,
            confirmationResult.body,
            executionName,
          );
          if (confirmedExecution.state !== "present") {
            return createProviderTermination({
              resource: reference.resource,
              outcome: "terminated",
              observedAtMs,
              details: operationDetails(reference, {
                phase: String(confirmedExecution.details.phase),
                executionName,
                cancellationOperation: cancellation.name,
              }),
            });
          }
        } catch {
          // The cancellation was already issued. Malformed confirmation is an
          // unknown outcome, not a safe reason to issue it again.
        }
      }
      return createProviderTermination({
        resource: reference.resource,
        outcome: "unknown",
        observedAtMs,
        details: operationDetails(reference, {
          phase: "cancellation_pending",
          executionName,
          cancellationOperation: cancellation.name,
        }),
      });
    },
  });
}
