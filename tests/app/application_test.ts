import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { createApplication } from "../../src/app/application.ts";
import { defineApplicationFactory } from "../../src/app/factory.ts";
import type {
  CompiledRoute,
  FileRouter,
  RouteMiddleware,
} from "../../src/router/types.ts";

function createTestRouter<State>(
  methods: CompiledRoute<State>["methods"],
  middlewares: readonly RouteMiddleware<State>[] = [],
): FileRouter<State> {
  const route = Object.freeze({
    pattern: "/items/:id",
    fileUrl: "file:///routes/items/[id].ts",
    segments: Object.freeze([]),
    methods: Object.freeze({ ...methods }),
  }) as CompiledRoute<State>;
  return Object.freeze({
    root: "file:///routes/",
    routes: Object.freeze([route]),
    match: (pathname: string) =>
      pathname.startsWith("/items/")
        ? Object.freeze({
          route,
          params: Object.freeze({ id: pathname.slice("/items/".length) }),
          middlewares: Object.freeze(
            middlewares.map((middleware, index) =>
              Object.freeze({
                fileUrl: `file:///routes/middleware-${index}.ts`,
                middleware,
              })
            ),
          ),
        })
        : null,
  });
}

Deno.test("application initializes once and runs one root-to-leaf onion chain", async () => {
  const order: string[] = [];
  let setupCalls = 0;
  let disposeCalls = 0;
  const routeMiddleware: RouteMiddleware<{ prefix: string }> = async (
    _request,
    context,
    next,
  ) => {
    order.push(`route-in:${context.params.id}`);
    const response = await next();
    order.push("route-out");
    return new Response(`${await response.text()}:route`);
  };
  const router = createTestRouter<{ prefix: string }>({
    GET: (_request, context) => {
      order.push("handler");
      return new Response(`${context.state.prefix}:${context.params.id}`);
    },
  }, [routeMiddleware]);
  const application = await createApplication({
    router,
    setup: () => {
      setupCalls++;
      return { prefix: "state" };
    },
    middleware: [
      async (_request, _context, next) => {
        order.push("app-in");
        const response = await next();
        order.push("app-out");
        return new Response(`${await response.text()}:app`);
      },
    ],
    dispose: () => {
      disposeCalls++;
    },
  });

  assertEquals(setupCalls, 1);
  const response = await application.fetch(
    new Request("https://example.test/items/42"),
  );
  assertEquals(await response.text(), "state:42:route:app");
  assertEquals(order, [
    "app-in",
    "route-in:42",
    "handler",
    "route-out",
    "app-out",
  ]);
  assertEquals(application.snapshot(), {
    acceptingRequests: true,
    activeRequests: 0,
  });

  const firstDispose = application.dispose("test_complete");
  const secondDispose = application.dispose("ignored");
  assertStrictEquals(firstDispose, secondDispose);
  await firstDispose;
  assertEquals(disposeCalls, 1);
  assertEquals(
    (await application.fetch(
      new Request("https://example.test/items/42"),
    )).status,
    503,
  );
});

Deno.test("application mounts routes at one exact segment-boundary basePath", async () => {
  const matchedPaths: string[] = [];
  const baseRouter = createTestRouter({
    GET: (request, context) =>
      new Response(`${new URL(request.url).pathname}:${context.params.id}`),
  });
  const router = Object.freeze({
    ...baseRouter,
    match(pathname: string) {
      matchedPaths.push(pathname);
      return baseRouter.match(pathname);
    },
  }) satisfies FileRouter<unknown>;
  const application = await createApplication({
    router,
    basePath: "/api",
  });

  assertEquals(application.basePath, "/api");
  const mounted = await application.fetch(
    new Request("https://example.test/api/items/42"),
  );
  assertEquals(await mounted.text(), "/api/items/42:42");
  assertEquals(
    (await application.fetch(
      new Request("https://example.test/api"),
    )).status,
    404,
  );
  assertEquals(
    (await application.fetch(
      new Request("https://example.test/api/"),
    )).status,
    404,
  );
  assertEquals(
    (await application.fetch(
      new Request("https://example.test/apix/items/42"),
    )).status,
    404,
  );
  assertEquals(matchedPaths, ["/items/42", "/", "/"]);
  await application.dispose();

  const rootApplication = await createApplication({ router: baseRouter });
  assertEquals(rootApplication.basePath, "/");
  await rootApplication.dispose();

  for (const invalid of ["/api/", "api", "//api", "/api//v1", "/a%2Fb"]) {
    await assertRejects(
      () => createApplication({ router: baseRouter, basePath: invalid }),
      TypeError,
      "canonical absolute",
    );
  }
});

Deno.test("application factory installs lifecycle, middleware, and error behavior", async () => {
  let setupCalls = 0;
  let disposeCalls = 0;
  let contextFrozen = false;
  const runtimeAbort = new AbortController();
  const router = createTestRouter<{ prefix: string }>({
    GET: (_request, context) => {
      if (context.params.id === "fail") throw new Error("route_failed");
      return new Response(`${context.state.prefix}:${context.params.id}`);
    },
  });
  const factory = defineApplicationFactory<{ prefix: string }>((context) => {
    contextFrozen = Object.isFrozen(context);
    assertStrictEquals(context.router, router);
    assertStrictEquals(context.signal, runtimeAbort.signal);
    return createApplication({
      router: context.router,
      basePath: context.basePath,
      setup: () => {
        setupCalls++;
        return { prefix: "factory" };
      },
      middleware: [
        async (_request, _context, next) => {
          const response = await next();
          return new Response(`${await response.text()}:middleware`, {
            status: response.status,
          });
        },
      ],
      onError: (error) =>
        new Response(error instanceof Error ? error.message : "unknown", {
          status: 598,
        }),
      dispose: () => {
        disposeCalls++;
      },
    });
  });

  const application = await factory({
    router,
    basePath: "/api",
    signal: runtimeAbort.signal,
  });
  assert(contextFrozen);
  assertEquals(application.basePath, "/api");
  assertEquals(setupCalls, 1);
  assertEquals(
    await (await application.fetch(
      new Request("https://example.test/api/items/7"),
    )).text(),
    "factory:7:middleware",
  );
  const failed = await application.fetch(
    new Request("https://example.test/api/items/fail"),
  );
  assertEquals(failed.status, 598);
  assertEquals(await failed.text(), "route_failed");
  await application.dispose("test_complete");
  assertEquals(disposeCalls, 1);
});

Deno.test("application implements 404, 405/Allow, HEAD, and OPTIONS", async () => {
  let getCalls = 0;
  let bodyCancelled = false;
  const router = createTestRouter({
    GET: () => {
      getCalls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("body"));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "x-handler": "get" } },
      );
    },
    POST: () => new Response("posted"),
  });
  const application = await createApplication({ router });

  const missing = await application.fetch(
    new Request("https://example.test/missing", { method: "HEAD" }),
  );
  assertEquals(missing.status, 404);
  assertEquals(missing.body, null);

  const head = await application.fetch(
    new Request("https://example.test/items/1", { method: "HEAD" }),
  );
  assertEquals(head.status, 200);
  assertEquals(head.headers.get("x-handler"), "get");
  assertEquals(head.body, null);
  assertEquals(getCalls, 1);
  assert(bodyCancelled);

  const options = await application.fetch(
    new Request("https://example.test/items/1", { method: "OPTIONS" }),
  );
  assertEquals(options.status, 204);
  assertEquals(options.headers.get("allow"), "GET, HEAD, POST, OPTIONS");

  const rejected = await application.fetch(
    new Request("https://example.test/items/1", { method: "DELETE" }),
  );
  assertEquals(rejected.status, 405);
  assertEquals(rejected.headers.get("allow"), "GET, HEAD, POST, OPTIONS");
  await rejected.body?.cancel();
  await application.dispose();
});

Deno.test("middleware errors are contained and next cannot run twice", async () => {
  const router = createTestRouter({
    GET: () => new Response("unreachable"),
  }, [
    async (_request, _context, next) => {
      await next();
      await next();
      return new Response("invalid");
    },
  ]);
  const application = await createApplication({
    router,
    onError: (error) =>
      new Response(error instanceof Error ? error.message : "unknown", {
        status: 598,
      }),
  });

  const response = await application.fetch(
    new Request("https://example.test/items/1"),
  );
  assertEquals(response.status, 598);
  assertEquals(
    await response.text(),
    "middleware next() may only be called once",
  );
  await application.dispose();
});

Deno.test("application disposal aborts and accounts for an unread response", async () => {
  let cancelReason: unknown;
  const router = createTestRouter({
    GET: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel(reason) {
            cancelReason = reason;
          },
        }),
      ),
  });
  const application = await createApplication({ router });
  const response = await application.fetch(
    new Request("https://example.test/items/1"),
  );
  assert(response.body !== null);
  assertEquals(application.snapshot().activeRequests, 1);

  await application.dispose("runtime_stopped");
  assertEquals(cancelReason, "runtime_stopped");
  assertEquals(application.snapshot(), {
    acceptingRequests: false,
    activeRequests: 0,
  });
  await assertRejects(() => response.text());
});

Deno.test("application disposal waits for asynchronous response cancellation", async () => {
  const cancellationStarted = Promise.withResolvers<void>();
  const releaseCancellation = Promise.withResolvers<void>();
  let cancellationFinished = false;
  let disposeHookCalled = false;
  const router = createTestRouter({
    GET: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async cancel() {
            cancellationStarted.resolve();
            await releaseCancellation.promise;
            cancellationFinished = true;
          },
        }),
      ),
  });
  const application = await createApplication({
    router,
    dispose: () => {
      disposeHookCalled = true;
    },
  });
  await application.fetch(new Request("https://example.test/items/1"));

  const disposal = application.dispose("runtime_stopped");
  await cancellationStarted.promise;
  assertEquals(cancellationFinished, false);
  assertEquals(disposeHookCalled, false);
  assertEquals(application.snapshot().activeRequests, 1);

  releaseCancellation.resolve();
  await disposal;
  assert(cancellationFinished);
  assert(disposeHookCalled);
  assertEquals(application.snapshot().activeRequests, 0);
});

Deno.test("middleware next cannot escape after its scope settles", async () => {
  let lateNext: (() => Promise<Response>) | undefined;
  let handlerCalls = 0;
  const router = createTestRouter({
    GET: () => {
      handlerCalls++;
      return new Response("downstream");
    },
  }, [
    (_request, _context, next) => {
      lateNext = next;
      return new Response("early");
    },
  ]);
  const application = await createApplication({ router });

  const response = await application.fetch(
    new Request("https://example.test/items/1"),
  );
  assertEquals(await response.text(), "early");
  assertEquals(application.snapshot().activeRequests, 0);
  assertThrows(
    () => lateNext!(),
    TypeError,
    "after middleware settles",
  );
  assertEquals(handlerCalls, 0);
  await application.dispose();
});

Deno.test("application rejects malformed percent-encoded paths with 400", async () => {
  const base = createTestRouter({});
  const router = Object.freeze({
    ...base,
    match(pathname: string) {
      decodeURIComponent(pathname);
      return null;
    },
  }) satisfies FileRouter<unknown>;
  const application = await createApplication({ router });

  const response = await application.fetch(
    new Request("https://example.test/%ZZ"),
  );
  assertEquals(response.status, 400);
  assertEquals(await response.text(), "Bad Request");
  await application.dispose();
});

Deno.test("application dispose is stable under abort-listener reentrancy", async () => {
  const applicationReference: {
    current?: Awaited<ReturnType<typeof createApplication<undefined>>>;
  } = {};
  let reentrantDisposal: Promise<void> | undefined;
  let disposeCalls = 0;
  let disposeReason: unknown;
  const router = createTestRouter<undefined>({
    GET: (_request, context) => {
      context.signal.addEventListener("abort", () => {
        reentrantDisposal = applicationReference.current!.dispose(
          "reentrant_reason",
        );
      }, { once: true });
      return new Response(null);
    },
  });
  const application = await createApplication({
    router,
    dispose: (_state, context) => {
      disposeCalls++;
      disposeReason = context.reason;
    },
  });
  applicationReference.current = application;
  await application.fetch(new Request("https://example.test/items/1"));

  const outerDisposal = application.dispose("outer_reason");
  assertStrictEquals(reentrantDisposal, outerDisposal);
  await outerDisposal;
  assertEquals(disposeCalls, 1);
  assertEquals(disposeReason, "outer_reason");
});

Deno.test("application rejects simultaneous setup and state", async () => {
  const router = createTestRouter({});
  await assertRejects(
    () =>
      createApplication({
        router,
        state: undefined,
        setup: () => undefined,
      }),
    TypeError,
    "either setup or state",
  );
});

Deno.test("application validates middleware and hooks before setup", async () => {
  const router = createTestRouter({});
  let setupCalls = 0;
  const setup = () => {
    setupCalls++;
    return undefined;
  };

  await assertRejects(
    () =>
      createApplication({
        router,
        setup,
        middleware: [null],
      } as never),
    TypeError,
    "only functions",
  );
  await assertRejects(
    () =>
      createApplication({
        router,
        setup,
        middleware: "not-an-array",
      } as never),
    TypeError,
    "must be an array",
  );
  await assertRejects(
    () =>
      createApplication({
        router,
        setup,
        onError: true,
      } as never),
    TypeError,
    "onError must be a function",
  );
  await assertRejects(
    () =>
      createApplication({
        router,
        setup,
        dispose: "not-a-function",
      } as never),
    TypeError,
    "dispose must be a function",
  );

  assertEquals(setupCalls, 0);
});

Deno.test("application aborts its lifecycle signal when setup fails", async () => {
  const router = createTestRouter({});
  const setupError = new Error("setup_failed");
  let setupSignal: AbortSignal | undefined;

  await assertRejects(
    () =>
      createApplication({
        router,
        setup: ({ signal }) => {
          setupSignal = signal;
          throw setupError;
        },
      }),
    Error,
    "setup_failed",
  );

  assert(setupSignal?.aborted);
  assertStrictEquals(setupSignal.reason, setupError);
});
