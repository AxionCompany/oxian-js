import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import { serve as nodeServe } from "../../src/adapters/node/server.ts";
import { serve as denoServe } from "../../src/adapters/deno/server.ts";
import { upgradeWebSocket } from "../../src/http/websocket.ts";

for (
  const [name, serve] of [["Node", nodeServe], ["Deno", denoServe]] as const
) {
  test(`${name}: a direct portable fallback endpoint exchanges messages and closes`, async () => {
    const hypervisor = createHypervisor({
      transports: [{
        type: "in-process",
        config: { topic: crypto.randomUUID() },
      }],
      fallback(request) {
        const { socket, response } = upgradeWebSocket(request);
        socket.onopen = () => socket.send("ready");
        socket.onmessage = (event) => socket.send(event.data);
        return response;
      },
    });
    const listener = await serve({
      hypervisor,
      hostname: "127.0.0.1",
      port: 0,
    });
    const client = new WebSocket(`ws://127.0.0.1:${listener.port}/device`);
    let count = 0;
    const finished = Promise.withResolvers<void>();
    const timer = setTimeout(
      () => finished.reject(new Error("direct endpoint timeout")),
      3000,
    );
    client.on("message", (data, binary) => {
      try {
        if (count++ === 0) {
          assert.equal(String(data), "ready");
          client.send("hello");
        } else if (count === 2) {
          assert.equal(binary, false);
          assert.equal(String(data), "hello");
          client.send(new Uint8Array([0, 255, 12]));
        } else {
          assert.equal(binary, true);
          assert.deepEqual([...data as Buffer], [0, 255, 12]);
          client.close(4002, "finished");
        }
      } catch (error) {
        finished.reject(error);
      }
    });
    client.on("close", (code) => {
      try {
        assert.equal(code, 4002);
        assert.equal(count, 3);
        finished.resolve();
      } catch (error) {
        finished.reject(error);
      }
    });
    client.on("error", finished.reject);
    try {
      await finished.promise;
    } finally {
      clearTimeout(timer);
      client.terminate();
      await listener.shutdown();
      await hypervisor.shutdown();
    }
  });
}
