import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDevProxyAdapter } from "../../src/edge/dev_proxy.ts";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(message, "TimeoutError")),
      2_000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function startLoopback(
  handler: (request: Request) => Response | Promise<Response>,
): Readonly<{
  origin: string;
  close(): Promise<void>;
}> {
  const abortController = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abortController.signal,
    onListen: () => undefined,
  }, handler);
  if (server.addr.transport !== "tcp") {
    abortController.abort();
    throw new TypeError("proxy test server did not bind TCP");
  }
  return Object.freeze({
    origin: `http://127.0.0.1:${server.addr.port}`,
    close: async () => {
      abortController.abort();
      await server.finished.catch(() => undefined);
    },
  });
}

const loopbackPermission = await Deno.permissions.query({
  name: "net",
  host: "127.0.0.1",
});

Deno.test({
  name: "dev proxy preserves request semantics and forwards original authority",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const upstream = startLoopback(async (request) => {
      return Response.json({
        method: request.method,
        path: new URL(request.url).pathname,
        query: new URL(request.url).search,
        host: request.headers.get("host"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        custom: request.headers.get("x-custom"),
        removed: request.headers.get("x-remove"),
        body: await request.text(),
      }, {
        headers: [
          ["set-cookie", "first=1; Path=/"],
          ["set-cookie", "second=2; Path=/"],
          ["x-upstream", "yes"],
        ],
      });
    });
    try {
      const handler = createDevProxyAdapter({
        upstream: `${upstream.origin}/base`,
        prefix: "/dev",
        stripPrefix: true,
        forwardHost: true,
      })(() => new Response("fallback"));
      const response = await handler(
        new Request("https://public.example/dev/items?id=42&sort=asc", {
          method: "POST",
          headers: {
            "connection": "x-remove",
            "host": "public.example",
            "x-custom": "preserved",
            "x-remove": "secret",
          },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("streamed body"));
              controller.close();
            },
          }),
        }),
      );

      assertEquals(response.status, 200);
      assertEquals(response.headers.get("x-upstream"), "yes");
      assertEquals(response.headers.getSetCookie(), [
        "first=1; Path=/",
        "second=2; Path=/",
      ]);
      assertEquals(await response.json(), {
        method: "POST",
        path: "/base/items",
        query: "?id=42&sort=asc",
        host: new URL(upstream.origin).host,
        forwardedHost: "public.example",
        custom: "preserved",
        removed: null,
        body: "streamed body",
      });
    } finally {
      await upstream.close();
    }
  },
});

Deno.test({
  name: "dev proxy defaults Host to upstream and removes response hop headers",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const upstream = startLoopback((request) => {
      return new Response(request.headers.get("host"), {
        headers: {
          "connection": "x-response-hop",
          "x-response-hop": "remove",
          "x-end-to-end": "preserve",
        },
      });
    });
    try {
      const handler = createDevProxyAdapter({
        upstream: upstream.origin,
      })(() => new Response("fallback"));
      const response = await handler(
        new Request("https://public.example/path", {
          headers: { host: "public.example" },
        }),
      );
      assertEquals(await response.text(), new URL(upstream.origin).host);
      assertEquals(response.headers.get("connection"), null);
      assertEquals(response.headers.get("x-response-hop"), null);
      assertEquals(response.headers.get("x-end-to-end"), "preserve");
    } finally {
      await upstream.close();
    }
  },
});

Deno.test({
  name: "dev proxy streams the response and propagates downstream cancellation",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const cancelled = createDeferred<unknown>();
    const upstream = startLoopback(() => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
          },
          cancel(reason) {
            cancelled.resolve(reason);
          },
        }),
      );
    });
    try {
      const handler = createDevProxyAdapter({
        upstream: upstream.origin,
      })(() => new Response("fallback"));
      const response = await handler(
        new Request("https://public.example/stream"),
      );
      assert(response.body);
      const reader = response.body.getReader();
      const first = await reader.read();
      assertEquals(
        new TextDecoder().decode(first.value),
        "first",
      );
      await reader.cancel("client stopped");
      await withTimeout(
        cancelled.promise,
        "proxy did not cancel the upstream response body",
      );
    } finally {
      await upstream.close();
    }
  },
});

Deno.test("dev proxy falls through outside its prefix and validates upstream", async () => {
  let calls = 0;
  const handler = createDevProxyAdapter({
    upstream: "http://127.0.0.1:9",
    prefix: "/dev",
  })(() => {
    calls++;
    return new Response("application", { status: 201 });
  });
  const response = await handler(
    new Request("https://public.example/api"),
  );
  assertEquals(response.status, 201);
  assertEquals(await response.text(), "application");
  assertEquals(calls, 1);

  assertThrows(
    () => createDevProxyAdapter({ upstream: "ftp://example.test" }),
    TypeError,
    "http: or https:",
  );
  assertThrows(
    () =>
      createDevProxyAdapter({
        upstream: "https://user:secret@example.test",
      }),
    TypeError,
    "credentials",
  );
  assertThrows(
    () =>
      createDevProxyAdapter({
        upstream: "https://example.test?fixed=true",
      }),
    TypeError,
    "query or fragment",
  );
});

Deno.test({
  name: "dev proxy converts connection failures to Bad Gateway",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const server = startLoopback(() => new Response("unused"));
    const upstream = server.origin;
    await server.close();
    const handler = createDevProxyAdapter({ upstream })(
      () => new Response("fallback"),
    );
    const response = await handler(
      new Request("https://public.example/path"),
    );
    assertEquals(response.status, 502);
    assertEquals(await response.text(), "Bad Gateway");
  },
});
