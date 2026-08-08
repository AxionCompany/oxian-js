import assert from "node:assert/strict";
import * as oxian from "../src/mod.ts";

for (
  const name of [
    "createApplication",
    "createHttpWorkload",
    "createHypervisor",
    "createWorker",
  ]
) {
  assert.equal(typeof oxian[name], "function", `${name} must be portable`);
}
for (
  const name of [
    "createDenoHypervisor",
    "createWorkerHost",
    "createWorkerClient",
    "createFileRouter",
    "createLocalProcessProvider",
    "createLocalRuntime",
  ]
) {
  assert.equal(name in oxian, false, `${name} must not leak from the root`);
}

const hypervisor = oxian.createHypervisor({
  persistAcceptance: () => Promise.resolve(),
});
const worker = oxian.createWorker({
  id: "node-portability-worker",
  transport: { type: "in-process", hypervisor },
  workloads: {
    echo: ({ input }) => ({ body: input }),
  },
});
const running = worker.run();
await worker.whenReady();
const operation = await hypervisor.dispatch({
  workload: "echo",
  body: new Uint8Array([1, 2, 3]),
});
assert.deepEqual(
  new Uint8Array(await new Response(operation.output).arrayBuffer()),
  new Uint8Array([1, 2, 3]),
);
await operation.completed;
await worker.stop("node_portability_complete");
await running;
await hypervisor.shutdown("node_portability_complete");

let receivedBody = "";
const workload = oxian.createHttpWorkload({
  async fetch(request) {
    receivedBody = await request.text();
    return new Response("ok");
  },
});
const request = new Request("https://example.test/echo", {
  method: "POST",
  body: "request-body",
});
await workload({
  streamId: "00000000-0000-4000-8000-000000000001",
  workload: oxian.HTTP_WORKLOAD,
  metadata: oxian.encodeHttpRequestMetadata(request, "node-portability"),
  input: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("request-body"));
      controller.close();
    },
  }),
  signal: new AbortController().signal,
  sendMetadata: () => Promise.resolve(),
});
assert.equal(receivedBody, "request-body");

console.log("Node portability check passed");
