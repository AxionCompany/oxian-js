import { assertEquals } from "@std/assert";
import { serve } from "../../src/adapters/deno/index.ts";
import {
  createApplication,
  createServerSentEvents,
} from "../../src/app/index.ts";
import {
  createHttpGateway,
  createHttpWorkload,
  HTTP_WORKLOAD,
} from "../../src/http/index.ts";
import {
  createHypervisor,
  type Hypervisor,
  type HypervisorListener,
} from "../../src/hypervisor/index.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import type {
  CompiledRoute,
  FileRouter,
  RouteMethods,
} from "../../src/router/types.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";
import {
  createWorker,
  type Worker,
  type WorkerResult,
} from "../../src/worker/index.ts";
import { createDeferred, streamOf } from "./test_utils.ts";

const TEST_TIMEOUT_MS = 5_000;

type HttpWebSocketHarness = Readonly<{
  hypervisor: Hypervisor;
  listener: HypervisorListener;
  worker: Worker;
  workerRun: Promise<WorkerResult>;
  close(): Promise<void>;
}>;

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(message, "TimeoutError")),
      TEST_TIMEOUT_MS,
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

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new DOMException(message, "TimeoutError");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function workerUrl(
  listener: HypervisorListener,
  path: string,
): URL {
  const url = new URL(path, listener.url);
  url.protocol = "ws:";
  return url;
}

async function startHarness(
  workload: ReturnType<typeof createHttpWorkload>,
): Promise<HttpWebSocketHarness> {
  const repository = createInMemoryWorkerRepository();
  await repository.define(createWorkerDefinition({
    workerId: "http-wss-worker",
    providerId: "attached",
    workloads: [HTTP_WORKLOAD],
    capacity: 1,
  }));
  const identity = (await repository.activate("http-wss-worker")).attempt
    .identity;
  const authority = createInMemoryRegistrationAuthority();
  const registration = await authority.issueRegistration(identity);
  const hypervisor = createHypervisor({
    admission: { type: "registered", authority, repository },
    persistAcceptance: () => Promise.resolve(),
    config: {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 500,
      leaseSweepIntervalMs: 10,
      shutdownTimeoutMs: 500,
      cancellationAckTimeoutMs: 250,
      maxConnectionAgeMs: 60_000,
      proactiveDrainMarginMs: 1_000,
    },
  });
  const listener = serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = createWorker({
    transport: {
      type: "websocket",
      url: workerUrl(listener, hypervisor.config.workerPath),
      allowInsecureLoopback: true,
      connectTimeoutMs: 1_000,
    },
    identity,
    credential: registration.credential,
    credentialPersistence: "ephemeral",
    workloads: { [HTTP_WORKLOAD]: workload },
    capacity: 1,
    reconnectDelay: () => 0,
    handshakeTimeoutMs: 1_000,
  });
  const workerRun = worker.run();

  try {
    await withTimeout(
      worker.whenReady(),
      "HTTP WebSocket worker did not become ready",
    );
    await waitFor(
      () => hypervisor.sessions.get(identity.workerId)?.phase === "ready",
      "Hypervisor did not publish the HTTP WebSocket worker session",
    );
  } catch (error) {
    await worker.stop("harness_start_failed").catch(() => undefined);
    await hypervisor.shutdown("harness_start_failed").catch(() => undefined);
    await listener.shutdown().catch(() => undefined);
    await workerRun.catch(() => undefined);
    throw error;
  }

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      await hypervisor.shutdown("test_cleanup").catch(() => undefined);
      await worker.stop("test_cleanup").catch(() => undefined);
      await listener.shutdown().catch(() => undefined);
      await withTimeout(workerRun, "HTTP WebSocket worker did not stop").catch(
        () => undefined,
      );
    })();
    return closed;
  };
  return Object.freeze({
    hypervisor,
    listener,
    worker,
    workerRun,
    close,
  });
}

const loopbackPermission = await Deno.permissions.query({
  name: "net",
  host: "127.0.0.1",
});

Deno.test({
  name:
    "HTTP gateway preserves large binary bodies and Set-Cookie over a real WebSocket",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const limit = WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
    const bytes = new Uint8Array(limit + 8_193);
    const responseCancelled = createDeferred<unknown>();
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = index % 251;
    }
    const workload = createHttpWorkload({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/cancel") {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel: responseCancelled.resolve,
            }, { highWaterMark: 0 }),
          );
        }
        const received = new Uint8Array(await request.arrayBuffer());
        const headers = new Headers({
          "content-type": "application/octet-stream",
        });
        headers.append("set-cookie", "first=1; Path=/");
        headers.append("set-cookie", "second=2; Path=/");
        return new Response(streamOf(received), {
          status: 201,
          statusText: "Created",
          headers,
        });
      },
    });
    const harness = await startHarness(workload);
    try {
      const gateway = createHttpGateway({
        dispatch: harness.hypervisor.dispatch,
        createRequestId: () => "wss-request-1",
      });
      const response = await withTimeout(
        gateway(
          new Request("https://gateway.test/upload", {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: streamOf(bytes),
          }),
        ),
        "HTTP WebSocket response metadata timed out",
      );

      assertEquals(response.status, 201);
      assertEquals(response.statusText, "Created");
      assertEquals(response.headers.getSetCookie(), [
        "first=1; Path=/",
        "second=2; Path=/",
      ]);
      assertEquals(
        new Uint8Array(
          await withTimeout(
            response.arrayBuffer(),
            "HTTP WebSocket response body timed out",
          ),
        ),
        bytes,
      );

      const cancelledResponse = await withTimeout(
        gateway(new Request("https://gateway.test/cancel")),
        "HTTP WebSocket cancellation response metadata timed out",
      );
      await withTimeout(
        cancelledResponse.body!.cancel("client_disconnected"),
        "HTTP WebSocket response cancellation timed out",
      );
      const cancellation = await withTimeout(
        responseCancelled.promise,
        "HTTP WebSocket application body was not cancelled",
      );
      assertEquals(cancellation instanceof DOMException, true);
      if (cancellation instanceof DOMException) {
        assertEquals(cancellation.name, "AbortError");
        assertEquals(cancellation.message, "client_disconnected");
      }
    } finally {
      await harness.close();
    }
  },
});

Deno.test({
  name: "Fetch application streams and cancels SSE over a real WebSocket",
  ignore: loopbackPermission.state !== "granted",
  async fn() {
    const cancelled = createDeferred<unknown>();
    const methods: RouteMethods<undefined> = Object.freeze({
      GET: (_request, context) => {
        const events = createServerSentEvents({
          signal: context.signal,
        });
        context.signal.addEventListener(
          "abort",
          () => cancelled.resolve(context.signal.reason),
          { once: true },
        );
        void events.send("ready", {
          event: "status",
          id: "first",
        }).catch(() => undefined);
        return events.response;
      },
    });
    const route = Object.freeze({
      pattern: "/events",
      fileUrl: "file:///test/routes/events.ts",
      segments: Object.freeze([]),
      methods,
    }) as CompiledRoute<undefined>;
    const router = Object.freeze({
      root: "file:///test/routes/",
      routes: Object.freeze([route]),
      match: (pathname: string) =>
        pathname === "/events"
          ? Object.freeze({
            route,
            params: Object.freeze({}),
            middlewares: Object.freeze([]),
          })
          : null,
    }) satisfies FileRouter<undefined>;
    const application = await createApplication({ router });
    const harness = await startHarness(createHttpWorkload({
      fetch: application.fetch,
    }));

    try {
      const gateway = createHttpGateway({
        dispatch: harness.hypervisor.dispatch,
        createRequestId: () => "sse-wss-request",
      });
      const response = await withTimeout(
        gateway(new Request("https://gateway.test/events")),
        "SSE metadata did not arrive over WebSocket",
      );
      assertEquals(
        response.headers.get("content-type"),
        "text/event-stream; charset=utf-8",
      );
      const reader = response.body!.getReader();
      const first = await withTimeout(
        reader.read(),
        "SSE first byte did not arrive over WebSocket",
      );
      assertEquals(first.done, false);
      assertEquals(
        new TextDecoder().decode(first.value),
        "id: first\nevent: status\ndata: ready\n\n",
      );

      await withTimeout(
        reader.cancel("browser_left"),
        "SSE consumer cancellation did not settle",
      );
      const reason = await withTimeout(
        cancelled.promise,
        "SSE application signal was not aborted",
      );
      assertEquals(reason instanceof DOMException, true);
      if (reason instanceof DOMException) {
        assertEquals(reason.name, "AbortError");
        assertEquals(reason.message, "browser_left");
      }
      await waitFor(
        () => application.snapshot().activeRequests === 0,
        "SSE application request remained active after cancellation",
      );
    } finally {
      await harness.close();
      await application.dispose("test_cleanup");
    }
  },
});
