import assert from "node:assert/strict";
import { Agent, request as httpRequest } from "node:http";
import { connect as connectTcp } from "node:net";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import { serve } from "./server.ts";

async function fixture(
  fallback: (request: Request) => Response | Promise<Response>,
) {
  const hypervisor = createHypervisor({
    transports: [
      { type: "in-process", config: { topic: crypto.randomUUID() } },
    ],
    fallback,
  });
  const listener = await serve({ hypervisor });
  return {
    listener,
    async close() {
      await listener.shutdown();
      await hypervisor.shutdown();
    },
  };
}
async function expectAborted(signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const aborted = await Promise.race([
      signal.aborted
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) =>
            signal.addEventListener("abort", () => resolve(true), {
              once: true,
            }),
          ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 500);
      }),
    ]);
    assert.equal(
      aborted,
      true,
      "server Request must observe the premature disconnect",
    );
    assert.equal((signal.reason as Error).name, "AbortError");
  } finally {
    clearTimeout(timer);
  }
}

for (const ending of ["client", "listener"] as const) {
  test(`Node Request aborts when ${ending} closes before fallback resolves`, {
    timeout: 5_000,
  }, async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const response = Promise.withResolvers<Response>();
    const f = await fixture((request) => {
      entered.resolve(request.signal);
      return response.promise;
    });
    const controller = new AbortController();
    const pending = fetch(f.listener.url, { signal: controller.signal }).catch(
      () => undefined,
    );
    try {
      const signal = await entered.promise;
      if (ending === "client") controller.abort();
      else await f.listener.shutdown();
      await pending;
      await expectAborted(signal);
    } finally {
      controller.abort();
      response.resolve(new Response("late"));
      await pending;
      await f.close();
    }
  });
}

test("Node Request aborts during a streamed response", {
  timeout: 5_000,
}, async () => {
  let signal: AbortSignal | undefined;
  let cancelled = false;
  const f = await fixture((request) => {
    signal = request.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  const controller = new AbortController();
  try {
    const response = await fetch(f.listener.url, { signal: controller.signal });
    const reader = response.body!.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "first",
    );
    controller.abort();
    await expectAborted(signal!);
    await reader.cancel().catch(() => undefined);
    for (let count = 0; !cancelled && count < 100; count++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(cancelled, true);
  } finally {
    controller.abort();
    await f.close();
  }
});

test("Node Request aborts when an incomplete incoming body is disconnected", {
  timeout: 5_000,
}, async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture((request) => {
    entered.resolve(request.signal);
    return response.promise;
  });
  const socket = connectTcp(f.listener.port, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.once("connect", () =>
    socket.write(
      "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx",
    ),
  );
  try {
    const signal = await entered.promise;
    socket.destroy();
    await expectAborted(signal);
  } finally {
    socket.destroy();
    response.resolve(new Response("late"));
    await f.close();
  }
});

test("Node request-body completion does not abort an unfinished response", {
  timeout: 5_000,
}, async () => {
  const read = Promise.withResolvers<AbortSignal>();
  const proceed = Promise.withResolvers<void>();
  const f = await fixture(async (request) => {
    assert.equal(await request.text(), "complete body");
    read.resolve(request.signal);
    await proceed.promise;
    assert.equal(request.signal.aborted, false);
    return new Response("complete response");
  });
  const pending = fetch(f.listener.url, {
    method: "POST",
    body: "complete body",
  });
  try {
    const signal = await read.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(signal.aborted, false);
    proceed.resolve();
    assert.equal(await (await pending).text(), "complete response");
    await f.listener.shutdown();
    assert.equal(signal.aborted, false);
  } finally {
    proceed.resolve();
    await pending.catch(() => undefined);
    await f.close();
  }
});

test("Node keep-alive requests have independent cancellation lifetimes", {
  timeout: 5_000,
}, async () => {
  const signals: AbortSignal[] = [];
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture((request) => {
    signals.push(request.signal);
    if (signals.length === 3) {
      entered.resolve();
      return response.promise;
    }
    return new Response("ok");
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const ports: number[] = [];
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const request = httpRequest(f.listener.url, { agent }, (response) => {
        ports.push(response.socket.localPort!);
        response.resume();
        response.once("end", resolve);
        response.once("error", reject);
      });
      request.once("error", reject);
      request.end();
    });
  let third: ReturnType<typeof httpRequest> | undefined;
  try {
    await run();
    await run();
    assert.equal(ports[0], ports[1]);
    assert.ok(signals.every((signal) => !signal.aborted));
    third = httpRequest(f.listener.url, { agent });
    third.on("error", () => undefined);
    third.end();
    await entered.promise;
    assert.equal(third.socket!.localPort, ports[0]);
    third.destroy();
    await expectAborted(signals[2]!);
    assert.equal(signals[0]!.aborted, false);
    assert.equal(signals[1]!.aborted, false);
  } finally {
    third?.destroy();
    agent.destroy();
    response.resolve(new Response("late"));
    await f.close();
  }
});

test("Node Upgrade fallback observes its own socket close", {
  timeout: 5_000,
}, async () => {
  const entered = Promise.withResolvers<AbortSignal>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture((request) => {
    entered.resolve(request.signal);
    return response.promise;
  });
  const socket = connectTcp(f.listener.port, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.once("connect", () =>
    socket.write(
      "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ),
  );
  try {
    const signal = await entered.promise;
    await f.listener.shutdown();
    await expectAborted(signal);
  } finally {
    socket.destroy();
    response.resolve(new Response("late"));
    await f.close();
  }
});

for (const kind of ["in-process", "websocket"] as const) {
  test(`Node client disconnect cancels real ${kind} HTTP work and releases its slot`, {
    timeout: 5_000,
  }, async () => {
    const { createHttpGateway, createHttpWorkload, HTTP_WORKLOAD } =
      await import("../../http/index.ts");
    const { createWorker } = await import("../../worker/worker.ts");
    const entered = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<void>();
    const local = {
      type: "in-process" as const,
      config: { topic: crypto.randomUUID() },
    };
    const identity = {
      workerId: "http-cancel",
      attemptId: crypto.randomUUID(),
      epoch: 1,
    };
    const hypervisor = createHypervisor({
      transports:
        kind === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
      fallback: (request) => gateway(request),
      config: {
        maxQueuedDispatches: 1,
        dispatchQueueTimeoutMs: 500,
        shutdownTimeoutMs: 100,
        cancellationAckTimeoutMs: 100,
      },
      admit: ({ credential }) => ({
        definition: {
          workerId: identity.workerId,
          providerId: "test",
          workloads: [HTTP_WORKLOAD],
          capacity: 1,
          providerConfig: {},
          labels: {},
        },
        sessionGeneration: 1,
        authenticatedWith: credential.kind,
        resume: {
          credential: { kind: "resume", capability: "resume-test" },
          expiresAtMs: Date.now() + 60_000,
        },
      }),
    });
    const gateway: (request: Request) => Promise<Response> = createHttpGateway({
      dispatch: hypervisor.dispatch,
      deadlineAtMs: () => Date.now() + 2_000,
    });
    const listener = await serve({ hypervisor });
    const url = new URL("/workers", listener.url);
    url.protocol = "ws:";
    const worker = createWorker({
      id: identity.workerId,
      transport:
        kind === "in-process"
          ? local
          : { type: "websocket", config: { url, allowInsecureLoopback: true } },
      capacity: 1,
      activate: () => identity,
      register: () => ({
        credential: { kind: "registration", capability: "registration-test" },
        expiresAtMs: Date.now() + 60_000,
      }),
      reconnectDelay: false,
      workloads: {
        [HTTP_WORKLOAD]: createHttpWorkload({
          fetch: async (request) => {
            if (new URL(request.url).pathname === "/ok")
              return new Response("next request");
            entered.resolve(request.signal);
            await new Promise<void>((resolve) => {
              if (request.signal.aborted) resolve();
              else
                request.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            stopped.resolve();
            return new Response("cancelled");
          },
        }),
      },
    });
    const controller = new AbortController();
    let pending: Promise<unknown> | undefined;
    try {
      await worker.ready;
      const connectionId = worker.snapshot().connectionId;
      pending = fetch(listener.url, { signal: controller.signal }).catch(
        () => undefined,
      );
      const signal = await entered.promise;
      assert.equal(worker.snapshot().occupiedExecutions, 1);
      controller.abort();
      await pending;
      await expectAborted(signal);
      await stopped.promise;
      const next = await fetch(new URL("/ok", listener.url));
      assert.equal(await next.text(), "next request");
      assert.equal(worker.snapshot().connectionId, connectionId);
    } finally {
      controller.abort();
      await pending;
      await worker.stop();
      await hypervisor.shutdown();
      await listener.shutdown();
    }
  });
}
