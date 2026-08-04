import { assertEquals, assertThrows } from "@std/assert";
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

Deno.test("HTTP request metadata round trips a strict Fetch-native shape", () => {
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

  assertEquals(metadata, {
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
  assertEquals(decodeHttpRequestMetadata(metadata), metadata);
  assertEquals(Object.isFrozen(metadata), true);
  assertEquals(Object.isFrozen(metadata.headers), true);
  assertEquals(Object.isFrozen(metadata.headers[0]), true);
});

Deno.test("HTTP response metadata preserves repeated Set-Cookie order", () => {
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
  assertEquals(metadata.schema, HTTP_RESPONSE_METADATA_SCHEMA);
  assertEquals(metadata.status, 202);
  assertEquals(metadata.statusText, "Accepted");
  assertEquals(metadata.hasBody, false);
  assertEquals(
    metadata.headers.filter(([name]) => name === "set-cookie"),
    [
      ["set-cookie", "first=1; Path=/"],
      ["set-cookie", "second=2; Path=/"],
    ],
  );
  assertEquals(
    createHeaders(metadata.headers).getSetCookie(),
    ["first=1; Path=/", "second=2; Path=/"],
  );
});

Deno.test("HTTP metadata rejects unknown fields and malformed pairs", () => {
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

Deno.test("HTTP response metadata rejects invalid status/body combinations", () => {
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
