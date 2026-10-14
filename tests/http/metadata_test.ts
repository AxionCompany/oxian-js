import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import type { JsonObject } from "../../src/protocol/types.ts";
import {
  createHeaders,
  decodeHttpRequestMetadata,
  decodeHttpResponseMetadata,
  encodeHttpRequestMetadata,
  encodeHttpResponseMetadata,
  HTTP_REQUEST_METADATA_SCHEMA,
  HTTP_RESPONSE_METADATA_SCHEMA,
} from "../../src/http/index.ts";

test("HTTP request metadata round trips a strict Fetch-native shape", () => {
  const headers = new Headers([
    ["content-type", "application/octet-stream"],
    ["x-request-value", "one"],
  ]);
  const request = new Request("https://example.test/items?q=1", {
    method: "POST",
    headers,
    body: new Uint8Array([1, 2, 3]),
  });
  const metadata = encodeHttpRequestMetadata(request, "request-1");

  assert.deepStrictEqual(metadata, {
    schema: HTTP_REQUEST_METADATA_SCHEMA,
    requestId: "request-1",
    method: "POST",
    url: "https://example.test/items?q=1",
    headers: [
      ["content-type", "application/octet-stream"],
      ["x-request-value", "one"],
    ],
    hasBody: true,
  });
  assert.deepStrictEqual(decodeHttpRequestMetadata(metadata), metadata);
  assert.deepStrictEqual(Object.isFrozen(metadata), true);
  assert.deepStrictEqual(Object.isFrozen(metadata.headers), true);
  assert.deepStrictEqual(Object.isFrozen(metadata.headers[0]), true);
});

test("HTTP response metadata preserves repeated Set-Cookie order", () => {
  const headers = new Headers();
  headers.append("set-cookie", "first=1; Path=/");
  headers.append("set-cookie", "second=2; Path=/");
  headers.append("x-response", "value");
  const response = new Response(null, {
    status: 202,
    statusText: "Accepted",
    headers,
  });

  const metadata = encodeHttpResponseMetadata(response);
  assert.deepStrictEqual(metadata.schema, HTTP_RESPONSE_METADATA_SCHEMA);
  assert.deepStrictEqual(metadata.status, 202);
  assert.deepStrictEqual(metadata.statusText, "Accepted");
  assert.deepStrictEqual(metadata.hasBody, false);
  assert.deepStrictEqual(
    metadata.headers.filter(([name]) => name === "set-cookie"),
    [
      ["set-cookie", "first=1; Path=/"],
      ["set-cookie", "second=2; Path=/"],
    ],
  );
  assert.deepStrictEqual(
    createHeaders(metadata.headers).getSetCookie(),
    ["first=1; Path=/", "second=2; Path=/"],
  );
});

test("HTTP metadata rejects unknown fields and malformed pairs", () => {
  const request = {
    schema: HTTP_REQUEST_METADATA_SCHEMA,
    requestId: "request-1",
    method: "POST",
    url: "https://example.test/",
    headers: [],
    hasBody: false,
  };

  assertThrows(
    () =>
      decodeHttpRequestMetadata({
        ...request,
        unknown: true,
      } as JsonObject),
    TypeError,
    "unexpected field unknown",
  );
  assertThrows(
    () =>
      decodeHttpRequestMetadata({
        ...request,
        headers: [["bad name", "value"]],
      } as JsonObject),
    TypeError,
    "invalid HTTP header name",
  );
  assertThrows(
    () =>
      decodeHttpRequestMetadata({
        ...request,
        method: "GET",
        hasBody: true,
      } as JsonObject),
    TypeError,
    "GET requests cannot carry a body",
  );
});

test("HTTP response metadata rejects invalid status/body combinations", () => {
  const base = {
    schema: HTTP_RESPONSE_METADATA_SCHEMA,
    status: 204,
    statusText: "No Content",
    headers: [],
    hasBody: false,
  };

  assertThrows(
    () =>
      decodeHttpResponseMetadata({
        ...base,
        hasBody: true,
      } as JsonObject),
    TypeError,
    "status 204 cannot carry a body",
  );
  assertThrows(
    () =>
      decodeHttpResponseMetadata({
        ...base,
        status: 199,
      } as JsonObject),
    TypeError,
    "between 200 and 599",
  );
  assertThrows(
    () =>
      decodeHttpResponseMetadata({
        ...base,
        statusText: "bad\r\ntext",
      } as JsonObject),
    TypeError,
    "cannot contain CR or LF",
  );
});
