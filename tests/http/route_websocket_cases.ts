import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createHypervisor } from "../../src/hypervisor/hypervisor.ts";
import { createEphemeralWorkerLifecycle } from "../../src/hypervisor/internal/ephemeral.ts";
import type {
  Hypervisor,
  HypervisorListener,
} from "../../src/hypervisor/types.ts";
import { createWorker } from "../../src/worker/worker.ts";
import {
  createHttpGateway,
  createHttpWorkload,
  HTTP_WORKLOAD,
} from "../../src/http/index.ts";
import {
  createConnectionBudget,
  type ConnectionBudget,
} from "../../src/http/connection-budget.ts";
import {
  getClientAddress,
  ROUTE_WEBSOCKET_LIMITS,
  upgradeWebSocket,
} from "../../src/http/websocket.ts";
import type {
  HttpFetchHandler,
  HttpWorkloadOptions,
} from "../../src/http/types.ts";

type Serve = (options: {
  hypervisor: Hypervisor;
  budget: ConnectionBudget;
}) => HypervisorListener | Promise<HypervisorListener>;

function deadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Socket test timed out")),
      5_000,
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

type RouteUpgrade = (
  request: Request,
  options?: { protocol?: string },
) => {
  socket: Pick<
    ReturnType<typeof upgradeWebSocket>["socket"],
    "onopen" | "onmessage" | "onclose" | "send" | "close"
  >;
  response: Response;
};
export function routeWebSocketCases(
  adapter: string,
  serve: Serve,
  native?: HttpWorkloadOptions["hostWebSocket"],
  upgrade: RouteUpgrade = upgradeWebSocket,
): void {
  for (const transport of ["in-process", "websocket"] as const) {
    const harness = async (fetch: HttpFetchHandler) => {
      const lifecycle = createEphemeralWorkerLifecycle();
      const budget = createConnectionBudget(3);
      const local = {
        type: "in-process" as const,
        config: { topic: crypto.randomUUID() },
      };
      const gateway = createHttpGateway({
        dispatch: (input) => hypervisor.dispatch(input),
      });
      const hypervisor = createHypervisor({
        transports:
          transport === "in-process"
            ? [local]
            : [
                {
                  type: "websocket",
                  config: { path: "/_oxian/workers/connect" },
                },
              ],
        fallback: gateway,
        admit: lifecycle.admit,
        config: { shutdownTimeoutMs: 100, cancellationAckTimeoutMs: 100 },
      });
      const listener = await serve({ hypervisor, budget });
      const url = new URL("/_oxian/workers/connect", listener.url);
      url.protocol = "ws:";
      let workerSocket: WebSocket | undefined;
      const worker = createWorker({
        id: "route-worker",
        capacity: 3,
        transport:
          transport === "in-process"
            ? local
            : {
                type: "websocket",
                config: {
                  url,
                  allowInsecureLoopback: true,
                  socket(context) {
                    workerSocket = new WebSocket(context.url, context.protocol);
                    return workerSocket as unknown as globalThis.WebSocket;
                  },
                },
              },
        activate: lifecycle.activate,
        register: lifecycle.register,
        workloads: {
          [HTTP_WORKLOAD]: createHttpWorkload({ fetch, hostWebSocket: native }),
        },
      });
      await deadline(worker.ready);
      return {
        listener,
        worker,
        budget,
        crash() {
          workerSocket!.terminate();
        },
        async close() {
          await worker.stop();
          await hypervisor.shutdown();
          await listener.shutdown();
        },
      };
    };

    test(`${adapter}/${transport}: route accepts only after admission; original request, text, binary, close and HTTP`, async () => {
      let requestSeen: Request | undefined;
      let address: string | undefined;
      const closed = Promise.withResolvers<number>();
      const h = await harness(async (request) => {
        if (request.headers.get("upgrade") !== "websocket")
          return new Response("ordinary");
        requestSeen = request;
        address = getClientAddress(request);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const { socket, response } = upgrade(request, { protocol: "echo.v1" });
        socket.onopen = () => socket.send("welcome");
        socket.onmessage = (event) =>
          event.data === "close"
            ? socket.close(4001, "route closed")
            : socket.send(event.data);
        socket.onclose = (event) => closed.resolve(event.code);
        return response;
      });
      let client: WebSocket | undefined;
      try {
        assert.equal(await (await fetch(h.listener.url)).text(), "ordinary");
        const url = new URL("/echo?original=yes", h.listener.url);
        url.protocol = "ws:";
        client = new WebSocket(url, ["echo.v1"], {
          headers: {
            Origin: "https://origin.example",
            Cookie: "session=proof",
            Host: "route.example",
            "X-App": "value",
          },
        });
        const messages: Array<{ bytes: Buffer; binary: boolean }> = [];
        const received = new EventTarget();
        client.on("message", (bytes: Buffer, binary) => {
          messages.push({ bytes, binary });
          received.dispatchEvent(new Event("message"));
        });
        const next = async () => {
          if (!messages.length)
            await deadline(
              new Promise<void>((resolve) =>
                received.addEventListener("message", () => resolve(), {
                  once: true,
                }),
              ),
            );
          return messages.shift()!;
        };
        const opened = Promise.withResolvers<void>();
        client.once("open", opened.resolve);
        client.once("error", opened.reject);
        let status = 0;
        client.once("upgrade", (response) => {
          status = response.statusCode!;
        });
        await deadline(opened.promise);
        assert.equal(status, 101);
        assert.equal(client.protocol, "echo.v1");
        assert.equal((await next()).bytes.toString(), "welcome");
        assert.equal(requestSeen?.method, "GET");
        assert.equal(
          requestSeen?.url,
          "http://route.example/echo?original=yes",
        );
        assert.equal(
          requestSeen?.headers.get("origin"),
          "https://origin.example",
        );
        assert.equal(requestSeen?.headers.get("cookie"), "session=proof");
        assert.equal(requestSeen?.headers.get("host"), "route.example");
        assert.equal(
          requestSeen?.headers.get("sec-websocket-protocol"),
          "echo.v1",
        );
        assert.equal(requestSeen?.headers.get("x-app"), "value");
        assert.ok(address?.includes("127.0.0.1"));
        client.send("text");
        assert.equal((await next()).bytes.toString(), "text");
        client.send(new Uint8Array([0, 255, 12]));
        const binary = await next();
        assert.equal(binary.binary, true);
        assert.deepEqual([...binary.bytes], [0, 255, 12]);
        const ending = new Promise<number>((resolve) =>
          client!.once("close", resolve),
        );
        client.send("close");
        assert.equal(await deadline(ending), 4001);
        assert.equal(await deadline(closed.promise), 4001);
      } finally {
        client?.terminate();
        await h.close();
      }
    });

    for (const refusal of [401, 403])
      test(`${adapter}/${transport}: refusal ${refusal} is HTTP with no upgrade`, async () => {
        const h = await harness(async () => {
          await Promise.resolve();
          return new Response("refused", { status: refusal });
        });
        try {
          const url = new URL(h.listener.url);
          url.protocol = "ws:";
          const client = new WebSocket(url);
          const status = new Promise<number>((resolve, reject) => {
            client.once("open", () => reject(new Error("Unexpected upgrade")));
            client.on("error", () => undefined);
            client.once("unexpected-response", (_request, response) => {
              resolve(response.statusCode!);
              response.resume();
              client.terminate();
            });
          });
          assert.equal(await deadline(status), refusal);
        } finally {
          await h.close();
        }
      });

    for (const action of [
      "client-close",
      "worker-stop",
      "oversize",
      "fragmented",
      "server-oversize",
      "budget",
    ] as const)
      test(`${adapter}/${transport}: ${action}`, async () => {
        const observed = Promise.withResolvers<number>();
        const h = await harness((request) => {
          const { socket, response } = upgrade(request);
          socket.onclose = (event) => observed.resolve(event.code);
          if (action === "server-oversize")
            socket.onopen = () =>
              socket.send(
                new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes + 1),
              );
          return response;
        });
        const url = new URL(h.listener.url);
        url.protocol = "ws:";
        const client = new WebSocket(url);
        const open = new Promise<void>((resolve, reject) => {
          client.once("open", resolve);
          client.once("error", reject);
        });
        const close = new Promise<number>((resolve) =>
          client.once("close", resolve),
        );
        try {
          await deadline(open);
          if (action === "client-close") {
            client.close(4002, "client closed");
            assert.equal(await deadline(observed.promise), 4002);
            assert.equal(await deadline(close), 4002);
          } else if (action === "worker-stop") {
            if (transport === "websocket") h.crash();
            else await h.worker.stop("crash");
            assert.equal(await deadline(close), 1011);
          } else if (action === "server-oversize") {
            assert.equal(await deadline(close), 1009);
          } else if (action === "fragmented") {
            client.send(
              new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes / 2),
              { fin: false },
            );
            client.send(
              new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes / 2 + 1),
              { fin: true },
            );
            assert.equal(await deadline(close), 1009);
          } else if (action === "oversize") {
            client.send(
              new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes + 1),
            );
            assert.equal(await deadline(close), 1009);
          } else {
            assert.equal(
              h.budget.snapshot().connections,
              transport === "websocket" ? 2 : 1,
            );
            const leases = [];
            while (h.budget.snapshot().connections < 3)
              leases.push(h.budget.connect());
            const extra = new WebSocket(url);
            extra.on("error", () => undefined);
            const status = new Promise<number>((resolve) =>
              extra.once("unexpected-response", (_request, response) => {
                resolve(response.statusCode!);
                response.resume();
                extra.terminate();
              }),
            );
            assert.equal(await deadline(status), 503);
            for (const lease of leases) lease.release();
            client.close();
            await deadline(close);
          }
        } finally {
          client.terminate();
          await h.close();
        }
        assert.equal(h.budget.snapshot().connections, 0);
      });
  }
}
