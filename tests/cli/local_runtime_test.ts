import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { join } from "@std/path";
import { defineConfig } from "../../src/config/index.ts";
import { createLocalRuntime } from "../../src/local/runtime.ts";

const APP_MODULE_URL = new URL(
  "../../src/app/index.ts",
  import.meta.url,
).href;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException("test timed out", "TimeoutError")),
      timeoutMs,
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

Deno.test({
  name:
    "start lifecycle serves real HTTP through an outbound loopback WebSocket worker",
  permissions: {
    net: ["127.0.0.1"],
    read: true,
    write: true,
  },
  async fn() {
    const root = await Deno.makeTempDir();
    const routesRoot = join(root, "routes");
    await Deno.mkdir(routesRoot);
    await Deno.writeTextFile(
      join(routesRoot, "index.ts"),
      `export function GET(request: Request): Response {
  const url = new URL(request.url);
  return Response.json({
    path: url.pathname,
    transport: "websocket",
  });
}
`,
    );
    const config = defineConfig({
      application: { routesRoot },
      gateway: {
        listener: { hostname: "127.0.0.1", port: 0 },
        workerTransport: "websocket",
        hypervisor: {
          heartbeatIntervalMs: 20,
          leaseTimeoutMs: 500,
          leaseSweepIntervalMs: 10,
          shutdownTimeoutMs: 500,
          cancellationAckTimeoutMs: 250,
          maxConnectionAgeMs: 60_000,
          proactiveDrainMarginMs: 1_000,
        },
        edge: {
          cors: { origins: "*" },
        },
      },
    });
    const lifecycle = createLocalRuntime({ config, mode: "start" });

    try {
      const firstStart = lifecycle.start();
      assertStrictEquals(lifecycle.start(), firstStart);
      const running = await firstStart;
      assertEquals(running.workerTransport, "websocket");
      if (running.workerTransport !== "websocket") {
        throw new Error("expected the worker WebSocket topology");
      }
      if (running.workerUrl === undefined) {
        throw new Error("expected the worker WebSocket URL");
      }
      assertEquals(running.workerUrl.protocol, "ws:");
      assertEquals(running.workerUrl.hostname, "127.0.0.1");
      assertEquals(running.application.basePath, "/");
      assertEquals(running.application.state, undefined);
      assertEquals(
        running.hypervisor.sessions.get(running.identity.workerId)?.phase,
        "ready",
      );

      const response = await fetch(
        new URL("/", running.listenerUrl),
        { headers: { origin: "https://client.example" } },
      );
      assertEquals(response.status, 200);
      assertEquals(response.headers.get("access-control-allow-origin"), "*");
      assertEquals(await response.json(), {
        path: "/",
        transport: "websocket",
      });

      await lifecycle.stop("test_complete");
      await lifecycle.stop("test_complete_again");
      await lifecycle.finished;
      assertEquals(lifecycle.snapshot().state, "stopped");
      await assertRejects(() => lifecycle.start());
    } finally {
      await lifecycle.stop("test_cleanup").catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "local runtime binds its worker to the Hypervisor in process by default",
  permissions: {
    net: ["127.0.0.1"],
    read: true,
    write: true,
  },
  async fn() {
    const root = await Deno.makeTempDir();
    const routesRoot = join(root, "routes");
    await Deno.mkdir(routesRoot);
    await Deno.writeTextFile(
      join(routesRoot, "index.ts"),
      `export function GET(): Response {
  return Response.json({ transport: "in-process" });
}
`,
    );
    const config = defineConfig({
      application: { routesRoot },
      gateway: {
        listener: { hostname: "127.0.0.1", port: 0 },
      },
    });
    const lifecycle = createLocalRuntime({ config });

    try {
      const running = await lifecycle.start();
      assertEquals(running.workerTransport, "in-process");
      if (running.workerTransport !== "in-process") {
        throw new Error("expected the in-process worker topology");
      }
      assertEquals(running.workerUrl, undefined);
      assertEquals(running.worker.snapshot().state, "ready");
      assertEquals(
        running.hypervisor.sessions.get(running.identity.workerId)?.phase,
        "ready",
      );
      assertEquals(
        running.hypervisor.sessions.get(running.identity.workerId)?.capacity,
        config.gateway.workerCapacity,
      );

      const response = await fetch(new URL("/", running.listenerUrl));
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { transport: "in-process" });
      assertEquals(lifecycle.snapshot().workerTransport, "in-process");
      assertEquals(lifecycle.snapshot().workerUrl, undefined);
    } finally {
      await lifecycle.stop("test_cleanup").catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

for (const workerTransport of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `local ${workerTransport} HTTP worker admits configured concurrency and returns 503 beyond it`,
    permissions: {
      net: ["127.0.0.1"],
      read: true,
      write: true,
    },
    async fn() {
      const root = await Deno.makeTempDir();
      const routesRoot = join(root, "routes");
      const releaseKey = `__oxian_release_${crypto.randomUUID()}`;
      await Deno.mkdir(routesRoot);
      await Deno.writeTextFile(
        join(routesRoot, "index.ts"),
        `const held = new Set<ReadableStreamDefaultController<Uint8Array>>();
Reflect.set(globalThis, ${JSON.stringify(releaseKey)}, () => {
  for (const controller of held) controller.close();
  held.clear();
});

export function GET(request: Request): Response {
  if (!new URL(request.url).searchParams.has("hold")) {
    return new Response("completed");
  }
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      held.add(controller);
      controller.enqueue(new TextEncoder().encode("accepted"));
    },
  }));
}
`,
      );
      const config = defineConfig({
        application: { routesRoot },
        gateway: {
          listener: { hostname: "127.0.0.1", port: 0 },
          workerTransport,
          workerCapacity: 2,
          hypervisor: {
            heartbeatIntervalMs: 20,
            leaseTimeoutMs: 500,
            leaseSweepIntervalMs: 10,
            shutdownTimeoutMs: 500,
            cancellationAckTimeoutMs: 250,
            maxConnectionAgeMs: 60_000,
            proactiveDrainMarginMs: 1_000,
          },
        },
      });
      const lifecycle = createLocalRuntime({ config });

      try {
        const running = await lifecycle.start();
        assertEquals(
          running.hypervisor.sessions.get(running.identity.workerId)?.capacity,
          2,
        );
        const first = await withTimeout(
          fetch(new URL("/?hold=first", running.listenerUrl)),
          1_000,
        );
        const second = await withTimeout(
          fetch(new URL("/?hold=second", running.listenerUrl)),
          1_000,
        );
        assertEquals(first.status, 200);
        assertEquals(second.status, 200);
        assertEquals(
          running.hypervisor.sessions.get(running.identity.workerId)?.reserved,
          2,
        );

        const overloaded = await withTimeout(
          fetch(new URL("/?hold=overloaded", running.listenerUrl)),
          1_000,
        );
        assertEquals(overloaded.status, 503);
        assertEquals(overloaded.headers.get("retry-after"), "1");
        assertEquals(overloaded.headers.get("cache-control"), "no-store");
        assertEquals(await overloaded.text(), "Service Unavailable");

        const release = Reflect.get(globalThis, releaseKey);
        if (typeof release !== "function") {
          throw new Error("route did not publish its test release callback");
        }
        release();
        assertEquals(await first.text(), "accepted");
        assertEquals(await second.text(), "accepted");

        let recovered: Response | undefined;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const candidate = await withTimeout(
            fetch(new URL("/?request=recovered", running.listenerUrl)),
            1_000,
          );
          if (candidate.status === 200) {
            recovered = candidate;
            break;
          }
          assertEquals(candidate.status, 503);
          await candidate.body?.cancel("retry_capacity_probe");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(recovered?.status, 200);
        assertEquals(await recovered?.text(), "completed");
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (
            running.hypervisor.sessions.get(running.identity.workerId)
              ?.reserved === 0
          ) break;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assertEquals(
          running.hypervisor.sessions.get(running.identity.workerId)?.reserved,
          0,
        );
      } finally {
        Reflect.deleteProperty(globalThis, releaseKey);
        await lifecycle.stop("test_cleanup").catch(() => undefined);
        await Deno.remove(root, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "local runtime loads the explicit application factory and honors its mount",
  permissions: {
    net: ["127.0.0.1"],
    read: true,
    write: true,
  },
  async fn() {
    const root = await Deno.makeTempDir();
    const routesRoot = join(root, "routes");
    const disposeMarker = join(root, "disposed.txt");
    await Deno.mkdir(routesRoot);
    await Deno.writeTextFile(
      join(routesRoot, "index.ts"),
      `export function GET(
  request: Request,
  context: { state: { source: string } },
): Response {
  if (new URL(request.url).searchParams.has("fail")) {
    throw new Error("factory_route_failed");
  }
  return new Response(context.state.source);
}
`,
    );
    await Deno.writeTextFile(
      join(root, "application.ts"),
      `import {
  createApplication,
  defineApplicationFactory,
} from ${JSON.stringify(APP_MODULE_URL)};

export default defineApplicationFactory((context) => {
  if (!Object.isFrozen(context)) throw new Error("context_not_frozen");
  const { router, basePath, signal } = context;
  return createApplication({
    router,
    basePath,
    setup: () => ({
      source: signal.aborted ? "aborted" : "configured-factory",
    }),
    middleware: [
      async (_request, _context, next) => {
        const response = await next();
        return new Response((await response.text()) + ":middleware", {
          status: response.status,
        });
      },
    ],
    onError: (error) => new Response(
      error instanceof Error ? error.message : "unknown",
      { status: 598 },
    ),
    dispose: () =>
      Deno.writeTextFile(
        ${JSON.stringify(disposeMarker)},
        "factory-disposed",
      ),
  });
});
`,
    );
    const config = defineConfig({
      application: {
        routesRoot,
        basePath: "/api",
        factory: join(root, "application.ts"),
      },
      gateway: {
        listener: { hostname: "127.0.0.1", port: 0 },
        hypervisor: {
          heartbeatIntervalMs: 20,
          leaseTimeoutMs: 500,
          leaseSweepIntervalMs: 10,
          shutdownTimeoutMs: 500,
          cancellationAckTimeoutMs: 250,
          maxConnectionAgeMs: 60_000,
          proactiveDrainMarginMs: 1_000,
        },
      },
    });
    // This test exercises application-factory behavior across three requests.
    // Fetch resolves at response headers, before the worker protocol terminal,
    // so those requests can briefly overlap even though the calls look serial.
    const lifecycle = createLocalRuntime({ config, capacity: 3 });

    try {
      const running = await lifecycle.start();
      assertEquals(running.application.basePath, "/api");
      assertEquals(running.application.state, {
        source: "configured-factory",
      });

      const mounted = await fetch(new URL("/api", running.listenerUrl));
      assertEquals(mounted.status, 200);
      assertEquals(await mounted.text(), "configured-factory:middleware");
      const outsideMount = await fetch(
        new URL("/apix", running.listenerUrl),
      );
      assertEquals(outsideMount.status, 404);
      // Reading status alone leaves this request concurrent with the next one:
      // Fetch resolves when headers arrive, while capacity is released only
      // after the worker's response stream reaches its protocol terminal.
      await outsideMount.arrayBuffer();
      const failed = await fetch(
        new URL("/api?fail=1", running.listenerUrl),
      );
      assertEquals(failed.status, 598);
      assertEquals(await failed.text(), "factory_route_failed");

      await lifecycle.stop("test_complete");
      await lifecycle.finished;
      assertEquals(await Deno.readTextFile(disposeMarker), "factory-disposed");
    } finally {
      await lifecycle.stop("test_cleanup").catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("local stop does not wait behind a route module still loading", async () => {
  const root = await Deno.makeTempDir();
  const routesRoot = join(root, "routes");
  await Deno.mkdir(routesRoot);
  await Deno.writeTextFile(
    join(routesRoot, "index.ts"),
    `await new Promise<void>((resolve) => setTimeout(resolve, 150));

export function GET(): Response {
  return new Response("too late");
}
`,
  );
  const config = defineConfig({
    application: { routesRoot },
    gateway: { listener: { port: 0 } },
  });
  const lifecycle = createLocalRuntime({ config });
  const starting = lifecycle.start();

  try {
    await withTimeout(lifecycle.stop("cancel_startup"), 100);
    await lifecycle.finished;
    assertEquals(lifecycle.snapshot().state, "stopped");
    assertEquals(lifecycle.snapshot().listenerUrl, undefined);
    await assertRejects(() => withTimeout(starting, 1_000));
  } finally {
    await lifecycle.stop("test_cleanup").catch(() => undefined);
    await starting.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("local stop does not wait behind a factory module still loading", async () => {
  const root = await Deno.makeTempDir();
  const routesRoot = join(root, "routes");
  const enteredPath = join(root, "factory-entered");
  await Deno.mkdir(routesRoot);
  await Deno.writeTextFile(
    join(routesRoot, "index.ts"),
    `export function GET(): Response { return new Response("ok"); }\n`,
  );
  await Deno.writeTextFile(
    join(root, "application.ts"),
    `import {
  createApplication,
  defineApplicationFactory,
} from ${JSON.stringify(APP_MODULE_URL)};

await Deno.writeTextFile(${JSON.stringify(enteredPath)}, "entered");
await new Promise<void>((resolve) => setTimeout(resolve, 150));

export default defineApplicationFactory(({ router, basePath }) =>
  createApplication({ router, basePath })
);
`,
  );
  const config = defineConfig({
    application: {
      routesRoot,
      factory: join(root, "application.ts"),
    },
    gateway: { listener: { port: 0 } },
  });
  const lifecycle = createLocalRuntime({ config });
  const starting = lifecycle.start();

  try {
    const deadline = Date.now() + 1_000;
    while (true) {
      try {
        await Deno.stat(enteredPath);
        break;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (Date.now() >= deadline) {
        throw new DOMException("factory did not begin loading", "TimeoutError");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await withTimeout(lifecycle.stop("cancel_factory_startup"), 100);
    await lifecycle.finished;
    assertEquals(lifecycle.snapshot().state, "stopped");
    await assertRejects(() => withTimeout(starting, 1_000));
  } finally {
    await lifecycle.stop("test_cleanup").catch(() => undefined);
    await starting.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("local stop during the factory disposes its unclaimed application", async () => {
  const root = await Deno.makeTempDir();
  const routesRoot = join(root, "routes");
  const disposeMarker = join(root, "application-disposed");
  const stopKey = `__oxian_local_stop_${crypto.randomUUID()}`;
  await Deno.mkdir(routesRoot);
  await Deno.writeTextFile(
    join(routesRoot, "index.ts"),
    `export function GET(): Response { return new Response("ok"); }\n`,
  );
  await Deno.writeTextFile(
    join(root, "application.ts"),
    `import {
  createApplication,
  defineApplicationFactory,
} from ${JSON.stringify(APP_MODULE_URL)};

export default defineApplicationFactory(({ router, basePath }) =>
  createApplication({
    router,
    basePath,
    setup: () => {
      const requestStop = Reflect.get(
        globalThis,
        ${JSON.stringify(stopKey)},
      );
      if (typeof requestStop !== "function") {
        throw new Error("missing_test_stop_callback");
      }
      requestStop();
      return { created: true };
    },
    dispose: () =>
      Deno.writeTextFile(
        ${JSON.stringify(disposeMarker)},
        "disposed",
      ),
  })
);
`,
  );
  const config = defineConfig({
    application: {
      routesRoot,
      factory: join(root, "application.ts"),
    },
    gateway: { listener: { port: 0 } },
  });
  const lifecycle = createLocalRuntime({ config });
  let stopTask: Promise<void> | undefined;
  Object.defineProperty(globalThis, stopKey, {
    configurable: true,
    value: () => {
      stopTask ??= lifecycle.stop("factory_requested_stop");
    },
  });
  const starting = lifecycle.start();

  try {
    await assertRejects(() => withTimeout(starting, 1_000));
    await withTimeout(
      stopTask ??
        Promise.reject(new Error("factory did not request runtime stop")),
      1_000,
    );
    await lifecycle.finished;
    assertEquals(lifecycle.snapshot().state, "stopped");
    assertEquals(await Deno.readTextFile(disposeMarker), "disposed");
  } finally {
    Reflect.deleteProperty(globalThis, stopKey);
    await lifecycle.stop("test_cleanup").catch(() => undefined);
    await starting.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});
