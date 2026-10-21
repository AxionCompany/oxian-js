import { serve } from "../../../src/adapters/node/server.ts";
import { createHypervisor } from "../../../src/hypervisor/index.ts";
import { createEphemeralWorkerLifecycle } from "../../../src/hypervisor/internal/ephemeral.ts";
import { createWorker } from "../../../src/worker/index.ts";
import {
  createHttpGateway,
  createHttpWorkload,
  HTTP_WORKLOAD,
  upgradeWebSocket,
} from "../../../src/http/index.ts";

const transport = process.argv[2];
const local = {
  type: "in-process" as const,
  config: { topic: crypto.randomUUID() },
};
const lifecycle = createEphemeralWorkerLifecycle();
const gateway = createHttpGateway({
  dispatch: (input) => hypervisor.dispatch(input),
});
const hypervisor = createHypervisor({
  transports: transport === "in-process"
    ? [local]
    : [{ type: "websocket", config: { path: "/_oxian/workers/connect" } }],
  fallback: gateway,
  admit: lifecycle.admit,
  config: { shutdownTimeoutMs: 100, cancellationAckTimeoutMs: 100 },
});
const listener = await serve({ hypervisor, hostname: "127.0.0.1", port: 0 });
const url = new URL("/_oxian/workers/connect", listener.url);
url.protocol = "ws:";
const worker = createWorker({
  id: "shutdown-worker",
  capacity: 4,
  transport: transport === "in-process"
    ? local
    : { type: "websocket", config: { url, allowInsecureLoopback: true } },
  activate: lifecycle.activate,
  register: lifecycle.register,
  workloads: {
    [HTTP_WORKLOAD]: createHttpWorkload({
      fetch(request) {
        if (new URL(request.url).searchParams.has("pending")) {
          console.log("PENDING");
          return new Promise((resolve) => {
            const done = () => resolve(new Response(null, { status: 503 }));
            request.signal.addEventListener("abort", done, { once: true });
            if (request.signal.aborted) done();
          });
        }
        const { socket, response } = upgradeWebSocket(request);
        socket.onmessage = (event) => socket.send(event.data);
        return response;
      },
    }),
  },
});
await worker.ready;
const stopped = Promise.withResolvers<void>();
const stop = () => stopped.resolve();
process.on("SIGTERM", stop);
console.log(`listening at ${listener.url}`);
await stopped.promise;
process.off("SIGTERM", stop);
await Promise.all([worker.stop(), listener.shutdown(), hypervisor.shutdown()]);
await worker.closed;
console.log("DISPOSED");
