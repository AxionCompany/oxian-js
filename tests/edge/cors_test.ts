import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCorsAdapter } from "../../src/edge/cors.ts";

Deno.test("cors grants only configured origins and safely merges Vary", async () => {
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
  assertEquals(await allowed.text(), "ok");
  assertEquals(
    allowed.headers.get("access-control-allow-origin"),
    "https://compass.example",
  );
  assertEquals(
    allowed.headers.get("access-control-allow-credentials"),
    "true",
  );
  assertEquals(
    allowed.headers.get("access-control-expose-headers"),
    "x-request-id",
  );
  assertEquals(allowed.headers.get("vary"), "Accept-Encoding, origin");

  const denied = await handler(
    new Request("https://api.example/items", {
      headers: { origin: "https://hostile.example" },
    }),
  );
  assertEquals(denied.status, 200);
  assertEquals(denied.headers.get("access-control-allow-origin"), null);
  assertEquals(
    denied.headers.get("access-control-allow-credentials"),
    null,
  );
  assertEquals(denied.headers.get("access-control-expose-headers"), null);
  assertEquals(denied.headers.get("vary"), "Accept-Encoding, origin");
  await denied.body?.cancel();

  const noOrigin = await handler(
    new Request("https://api.example/items"),
  );
  assertEquals(noOrigin.headers.get("access-control-allow-origin"), null);
  assertEquals(noOrigin.headers.get("vary"), "Accept-Encoding, origin");
  await noOrigin.body?.cancel();
});

Deno.test("cors handles valid preflight without invoking the application", async () => {
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
  assertEquals(response.status, 204);
  assertEquals(applicationCalls, 0);
  assertEquals(
    response.headers.get("access-control-allow-origin"),
    "https://compass.example",
  );
  assertEquals(
    response.headers.get("access-control-allow-methods"),
    "GET, POST",
  );
  assertEquals(
    response.headers.get("access-control-allow-headers"),
    "authorization, x-client",
  );
  assertEquals(response.headers.get("access-control-max-age"), "600");
  assertEquals(
    response.headers.get("vary"),
    "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  );
});

Deno.test("cors rejects denied preflights and never reflects wildcard credentials", async () => {
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
  assertEquals(deniedMethod.status, 403);
  assertEquals(
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
  assertEquals(deniedHeader.status, 403);

  assertThrows(
    () => createCorsAdapter({ origins: "*", credentials: true }),
    TypeError,
    "wildcard origin",
  );

  const wildcard = createCorsAdapter({ origins: "*" })(
    () => new Response("ok"),
  );
  const sameOrigin = await wildcard(new Request("https://api.example/items"));
  assertEquals(
    sameOrigin.headers.get("access-control-allow-origin"),
    "*",
  );
  assertEquals(sameOrigin.headers.get("vary"), null);
  await sameOrigin.body?.cancel();
});

Deno.test("cors validates origin policy and contains predicate errors", async () => {
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
