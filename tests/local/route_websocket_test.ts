import assert from "node:assert/strict";
import { test } from "node:test";
import { serve } from "../../src/adapters/deno/server.ts";
import { hostWebSocket } from "../../src/adapters/deno/route-websocket.ts";
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
