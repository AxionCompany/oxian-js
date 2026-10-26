import assert from "node:assert/strict";
import { test } from "node:test";
import { handler, serve } from "../../src/adapters/deno/index.ts";
import { hostWebSocket } from "../../src/adapters/deno/route-websocket.ts";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import { acceptedWebSocket } from "../../src/http/websocket.ts";
import { routeWebSocketCases } from "../http/route_websocket_cases.ts";
routeWebSocketCases("Deno", serve, hostWebSocket);
routeWebSocketCases(
  "Deno native routes",
  serve,
  hostWebSocket,
  (request, options) => {
    const result = Deno.upgradeWebSocket(request, options);
    result.socket.binaryType = "arraybuffer";
    return result;
  },
);

test("route-hosted Hypervisor upgrades preserve the public URL and headers", async () => {
  const path = "/api/shard-owner";
  const hypervisor = createHypervisor({
    transports: [{ type: "websocket", config: { path } }],
    admit: () => {
      throw new Error("This test only performs the WebSocket handshake");
    },
  });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort("test timeout"), 3_000);
  const request = new Request(
    "https://example.test/api/shard-owner?shard=one",
    {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "oxian.worker.v1",
        authorization: "Bearer route-test",
      },
      signal: abort.signal,
    },
  );
  let prepared: Request | undefined;
  try {
    const response = await hostWebSocket(
      request,
      handler({
        ...hypervisor,
        prepare(request) {
          prepared = request;
          return hypervisor.prepare(request);
        },
      }),
    );
    assert.equal(response.status, 101);
    const protocol = acceptedWebSocket(response)?.protocol;
    assert.equal(protocol, "oxian.worker.v1");
    assert.equal(prepared?.url, request.url);
    assert.equal(prepared?.method, request.method);
    assert.deepEqual([...prepared!.headers], [...request.headers]);
    assert.equal(hypervisor.snapshot().connections, 1);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await hypervisor.shutdown();
  }
});

test("native route cancellation waits for actual handler settlement", async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let settled = false;
  const request = new Request("http://example.test/echo", {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
    },
    signal: abort.signal,
  });
  const pending = hostWebSocket(request, () => {
    entered.resolve();
    return release.promise;
  });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release.resolve(new Response(null, { status: 403 }));
  await assert.rejects(pending);
});
