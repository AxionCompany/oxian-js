import { WORKER_PROTOCOL_LIMITS } from "../protocol/limits.ts";
import type { JsonObject } from "../protocol/types.ts";
import {
  HTTP_REQUEST_METADATA_SCHEMA,
  HTTP_RESPONSE_METADATA_SCHEMA,
  type HttpHeaderPair,
  type HttpRequestMetadata,
  type HttpResponseMetadata,
} from "./types.ts";

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 64;
const MAX_URL_LENGTH = 16_384;
const MAX_HEADER_COUNT = 256;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 16_384;
const MAX_STATUS_TEXT_LENGTH = 1_024;
const MAX_HTTP_METADATA_BYTES = WORKER_PROTOCOL_LIMITS.maxControlFrameBytes -
  4 * 1_024;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const textEncoder = new TextEncoder();

type UnknownRecord = Record<string, unknown>;

export type HttpMetadataLimits = Readonly<{
  maxRequestIdLength: number;
  maxMethodLength: number;
  maxUrlLength: number;
  maxHeaderCount: number;
  maxHeaderNameLength: number;
  maxHeaderValueLength: number;
  maxStatusTextLength: number;
  maxMetadataBytes: number;
}>;

export const HTTP_METADATA_LIMITS: HttpMetadataLimits = Object.freeze({
  maxRequestIdLength: MAX_REQUEST_ID_LENGTH,
  maxMethodLength: MAX_METHOD_LENGTH,
  maxUrlLength: MAX_URL_LENGTH,
  maxHeaderCount: MAX_HEADER_COUNT,
  maxHeaderNameLength: MAX_HEADER_NAME_LENGTH,
  maxHeaderValueLength: MAX_HEADER_VALUE_LENGTH,
  maxStatusTextLength: MAX_STATUS_TEXT_LENGTH,
  maxMetadataBytes: MAX_HTTP_METADATA_BYTES,
});

function invalid(path: string, message: string): never {
  throw new TypeError(`Invalid HTTP workload metadata at ${path}: ${message}`);
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "expected a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "expected a plain object");
  }
  return value as UnknownRecord;
}

function expectExactKeys(
  record: UnknownRecord,
  path: string,
  required: readonly string[],
): void {
  const expected = new Set(required);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !expected.has(key)) {
      invalid(path, `unexpected field ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      invalid(path, `missing field ${key}`);
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    const minimum = allowEmpty ? "" : "non-empty ";
    return invalid(
      path,
      `expected a ${minimum}string no longer than ${maximum} characters`,
    );
  }
  return value;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") return invalid(path, "expected a boolean");
  return value;
}

function expectSchema<T extends string>(
  value: unknown,
  schema: T,
  path: string,
): T {
  if (value !== schema) return invalid(path, `expected ${schema}`);
  return schema;
}

function validateHeaderPair(
  value: unknown,
  path: string,
): HttpHeaderPair {
  if (!Array.isArray(value) || value.length !== 2) {
    return invalid(path, "expected a two-item [name, value] pair");
  }
  if (
    Reflect.ownKeys(value).some((key) => {
      if (key === "length") return false;
      return key !== "0" && key !== "1";
    })
  ) {
    return invalid(path, "header pairs cannot contain extra fields");
  }
  const name = expectString(
    value[0],
    `${path}[0]`,
    MAX_HEADER_NAME_LENGTH,
  );
  const headerValue = expectString(
    value[1],
    `${path}[1]`,
    MAX_HEADER_VALUE_LENGTH,
    true,
  );
  if (!HTTP_TOKEN_PATTERN.test(name)) {
    return invalid(`${path}[0]`, "invalid HTTP header name");
  }
  try {
    new Headers([[name, headerValue]]);
  } catch {
    return invalid(path, "invalid HTTP header");
  }
  return Object.freeze([name.toLowerCase(), headerValue]);
}

function expectHeaders(
  value: unknown,
  path: string,
): readonly HttpHeaderPair[] {
  if (!Array.isArray(value)) return invalid(path, "expected an array");
  if (value.length > MAX_HEADER_COUNT) {
    return invalid(path, `cannot contain more than ${MAX_HEADER_COUNT} pairs`);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      invalid(`${path}[${index}]`, "header arrays cannot contain holes");
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      invalid(path, `unexpected field ${String(key)}`);
    }
  }
  return Object.freeze(
    value.map((entry, index) => validateHeaderPair(entry, `${path}[${index}]`)),
  );
}

function expectMethod(value: unknown, path: string): string {
  const method = expectString(value, path, MAX_METHOD_LENGTH);
  if (!HTTP_TOKEN_PATTERN.test(method)) {
    return invalid(path, "invalid HTTP method");
  }
  return method;
}

function expectUrl(value: unknown, path: string): string {
  const url = expectString(value, path, MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid(path, "expected an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return invalid(path, "URL protocol must be http: or https:");
  }
  return parsed.href;
}

function expectStatus(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 200 ||
    value > 599
  ) {
    return invalid(path, "expected an integer between 200 and 599");
  }
  return value;
}

function expectStatusText(value: unknown, path: string): string {
  const statusText = expectString(
    value,
    path,
    MAX_STATUS_TEXT_LENGTH,
    true,
  );
  if (statusText.includes("\r") || statusText.includes("\n")) {
    return invalid(path, "status text cannot contain CR or LF");
  }
  return statusText;
}

function enforceMetadataSize(value: JsonObject, path: string): void {
  const bytes = textEncoder.encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_HTTP_METADATA_BYTES) {
    invalid(
      path,
      `encoded metadata is ${bytes} bytes; limit is ${MAX_HTTP_METADATA_BYTES}`,
    );
  }
}

function headerPairs(headers: Headers): readonly HttpHeaderPair[] {
  const pairs: HttpHeaderPair[] = [];
  const cookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [];
  let emittedCookies = false;

  for (const [name, value] of headers) {
    if (name.toLowerCase() === "set-cookie" && cookies.length > 0) {
      if (!emittedCookies) {
        for (const cookie of cookies) {
          pairs.push(Object.freeze(["set-cookie", cookie]));
        }
        emittedCookies = true;
      }
      continue;
    }
    pairs.push(Object.freeze([name.toLowerCase(), value]));
  }
  if (!emittedCookies) {
    for (const cookie of cookies) {
      pairs.push(Object.freeze(["set-cookie", cookie]));
    }
  }
  if (pairs.length > MAX_HEADER_COUNT) {
    invalid(
      "$.headers",
      `cannot contain more than ${MAX_HEADER_COUNT} pairs`,
    );
  }
  return Object.freeze(pairs);
}

export function createHeaders(
  pairs: readonly HttpHeaderPair[],
): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) headers.append(name, value);
  return headers;
}

export function encodeHttpRequestMetadata(
  request: Request,
  requestId: string,
): HttpRequestMetadata {
  const value = {
    schema: HTTP_REQUEST_METADATA_SCHEMA,
    requestId,
    method: request.method,
    url: request.url,
    headers: headerPairs(request.headers),
    hasBody: request.body !== null,
  };
  return decodeHttpRequestMetadata(value as JsonObject);
}

export function decodeHttpRequestMetadata(
  value: JsonObject,
): HttpRequestMetadata {
  const record = expectRecord(value, "$");
  expectExactKeys(record, "$", [
    "schema",
    "requestId",
    "method",
    "url",
    "headers",
    "hasBody",
  ]);
  const method = expectMethod(record.method, "$.method");
  const hasBody = expectBoolean(record.hasBody, "$.hasBody");
  if (hasBody && (method === "GET" || method === "HEAD")) {
    invalid("$.hasBody", `${method} requests cannot carry a body`);
  }
  const metadata = Object.freeze({
    schema: expectSchema(
      record.schema,
      HTTP_REQUEST_METADATA_SCHEMA,
      "$.schema",
    ),
    requestId: expectString(
      record.requestId,
      "$.requestId",
      MAX_REQUEST_ID_LENGTH,
    ),
    method,
    url: expectUrl(record.url, "$.url"),
    headers: expectHeaders(record.headers, "$.headers"),
    hasBody,
  }) as HttpRequestMetadata;
  enforceMetadataSize(metadata, "$");
  return metadata;
}

export function encodeHttpResponseMetadata(
  response: Response,
  options: Readonly<{ hasBody?: boolean }> = {},
): HttpResponseMetadata {
  const value = {
    schema: HTTP_RESPONSE_METADATA_SCHEMA,
    status: response.status,
    statusText: response.statusText,
    headers: headerPairs(response.headers),
    hasBody: options.hasBody ?? response.body !== null,
  };
  return decodeHttpResponseMetadata(value as JsonObject);
}

export function decodeHttpResponseMetadata(
  value: JsonObject,
): HttpResponseMetadata {
  const record = expectRecord(value, "$");
  expectExactKeys(record, "$", [
    "schema",
    "status",
    "statusText",
    "headers",
    "hasBody",
  ]);
  const status = expectStatus(record.status, "$.status");
  const hasBody = expectBoolean(record.hasBody, "$.hasBody");
  if (
    hasBody &&
    (status === 204 || status === 205 || status === 304)
  ) {
    invalid("$.hasBody", `status ${status} cannot carry a body`);
  }
  const metadata = Object.freeze({
    schema: expectSchema(
      record.schema,
      HTTP_RESPONSE_METADATA_SCHEMA,
      "$.schema",
    ),
    status,
    statusText: expectStatusText(record.statusText, "$.statusText"),
    headers: expectHeaders(record.headers, "$.headers"),
    hasBody,
  }) as HttpResponseMetadata;
  enforceMetadataSize(metadata, "$");
  return metadata;
}
