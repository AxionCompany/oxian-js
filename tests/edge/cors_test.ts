import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../support/assert.ts";
import { createCorsAdapter } from "../../src/edge/cors.ts";

test("cors grants only configured origins and safely merges Vary", async () => {
  const handler = createCorsAdapter({
    origins: ["https://compass.example"],
    credentials: true,
    exposeHeaders: ["x-request-id"],
  })(() =>
    new Response("ok", {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true",
        "access-control-expose-headers": "x-untrusted",
        "vary": "Accept-Encoding, origin",
        "x-request-id": "request-1",
      },
    })
  );

  const allowed = await handler(
    new Request("https://api.example/items", {
      headers: { origin: "https://compass.example" },
    }),
  );
  assert.deepStrictEqual(await allowed.text(), "ok");
  assert.deepStrictEqual(
    allowed.headers.get("access-control-allow-origin"),
    "https://compass.example",
  );
  assert.deepStrictEqual(
    allowed.headers.get("access-control-allow-credentials"),
    "true",
  );
  assert.deepStrictEqual(
    allowed.headers.get("access-control-expose-headers"),
    "x-request-id",
  );
  assert.deepStrictEqual(
    allowed.headers.get("vary"),
    "Accept-Encoding, origin",
  );

  const denied = await handler(
    new Request("https://api.example/items", {
      headers: { origin: "https://hostile.example" },
    }),
  );
  assert.deepStrictEqual(denied.status, 200);
  assert.deepStrictEqual(
    denied.headers.get("access-control-allow-origin"),
    null,
  );
  assert.deepStrictEqual(
    denied.headers.get("access-control-allow-credentials"),
    null,
  );
  assert.deepStrictEqual(
    denied.headers.get("access-control-expose-headers"),
    null,
  );
  assert.deepStrictEqual(denied.headers.get("vary"), "Accept-Encoding, origin");
  await denied.body?.cancel();

  const noOrigin = await handler(
    new Request("https://api.example/items"),
  );
  assert.deepStrictEqual(
    noOrigin.headers.get("access-control-allow-origin"),
    null,
  );
  assert.deepStrictEqual(
    noOrigin.headers.get("vary"),
    "Accept-Encoding, origin",
  );
  await noOrigin.body?.cancel();
});

test("cors handles valid preflight without invoking the application", async () => {
  let applicationCalls = 0;
  const handler = createCorsAdapter({
    origins: (origin) => origin.endsWith(".example"),
    methods: ["GET", "POST"],
    headers: ["authorization", "x-client"],
    credentials: true,
    maxAgeSeconds: 600,
  })(() => {
    applicationCalls++;
    return new Response("application");
  });

  const response = await handler(
    new Request("https://api.example/items", {
      method: "OPTIONS",
      headers: {
        "origin": "https://compass.example",
        "access-control-request-method": "post",
        "access-control-request-headers": "X-Client, Authorization",
      },
    }),
  );
  assert.deepStrictEqual(response.status, 204);
  assert.deepStrictEqual(applicationCalls, 0);
  assert.deepStrictEqual(
    response.headers.get("access-control-allow-origin"),
    "https://compass.example",
  );
  assert.deepStrictEqual(
    response.headers.get("access-control-allow-methods"),
    "GET, POST",
  );
  assert.deepStrictEqual(
    response.headers.get("access-control-allow-headers"),
    "authorization, x-client",
  );
  assert.deepStrictEqual(response.headers.get("access-control-max-age"), "600");
  assert.deepStrictEqual(
    response.headers.get("vary"),
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );
});

test("cors permits QUERY by default", async () => {
  const handler = createCorsAdapter({ origins: "*" })(
    () => new Response("unreachable"),
  );
  const response = await handler(
    new Request("https://api.example/items", {
      method: "OPTIONS",
      headers: {
        origin: "https://compass.example",
        "access-control-request-method": "QUERY",
      },
    }),
  );

  assert.deepStrictEqual(response.status, 204);
  assert.deepStrictEqual(
    response.headers.get("access-control-allow-methods"),
    "GET, HEAD, QUERY, POST, PUT, PATCH, DELETE, OPTIONS",
  );
});

test("cors rejects denied preflights and never reflects wildcard credentials", async () => {
  const handler = createCorsAdapter({
    origins: ["https://compass.example"],
    methods: ["POST"],
    headers: ["content-type"],
  })(() => new Response("unreachable"));

  const deniedMethod = await handler(
    new Request("https://api.example/items", {
      method: "OPTIONS",
      headers: {
        "origin": "https://compass.example",
        "access-control-request-method": "DELETE",
      },
    }),
  );
  assert.deepStrictEqual(deniedMethod.status, 403);
  assert.deepStrictEqual(
    deniedMethod.headers.get("access-control-allow-origin"),
    null,
  );

  const deniedHeader = await handler(
    new Request("https://api.example/items", {
      method: "OPTIONS",
      headers: {
        "origin": "https://compass.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-unconfigured",
      },
    }),
  );
  assert.deepStrictEqual(deniedHeader.status, 403);

  assertThrows(
    () => createCorsAdapter({ origins: "*", credentials: true }),
    TypeError,
    "wildcard origin",
  );

  const wildcard = createCorsAdapter({ origins: "*" })(
    () => new Response("ok"),
  );
  const sameOrigin = await wildcard(new Request("https://api.example/items"));
  assert.deepStrictEqual(
    sameOrigin.headers.get("access-control-allow-origin"),
    "*",
  );
  assert.deepStrictEqual(sameOrigin.headers.get("vary"), null);
  await sameOrigin.body?.cancel();
});

test("cors validates origin policy and contains predicate errors", async () => {
  assertThrows(
    () => createCorsAdapter({ origins: ["https://example.com/"] }),
    TypeError,
    "serialized HTTP(S) origins",
  );
  assertThrows(
    () =>
      createCorsAdapter({
        origins: [],
        headers: ["invalid header"],
      }),
    TypeError,
    "valid HTTP tokens",
  );

  const handler = createCorsAdapter({
    origins: () => {
      throw new Error("policy unavailable");
    },
  })(() => new Response("application"));
  await assertRejects(
    async () =>
      await handler(
        new Request("https://api.example", {
          headers: { origin: "https://compass.example" },
        }),
      ),
    Error,
    "policy unavailable",
  );
});
