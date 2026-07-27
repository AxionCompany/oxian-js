import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { join } from "@std/path";
import { createHttpGateway, HTTP_WORKLOAD } from "../../src/http/index.ts";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import { loadWorkerManifest } from "../../src/local/worker_manifest.ts";
import { createManifestWorkerRuntime } from "../../src/local/worker_runtime.ts";
import type { ManifestWorkerRuntime } from "../../src/local/types.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";

const APP_MODULE_URL = new URL(
  "../../src/app/index.ts",
  import.meta.url,
).href;

async function waitForReady(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new DOMException("worker was not published", "TimeoutError");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = 1_000,
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
    "manifest worker durably resumes across a process restart with a newer fenced session",
  permissions: {
    net: ["127.0.0.1"],
    read: true,
    write: true,
  },
  async fn() {
    const root = await Deno.makeTempDir();
    const repository = createInMemoryWorkerRepository();
    await repository.define(createWorkerDefinition({
      workerId: "manifest-worker-live",
      providerId: "externally-attached",
      workloads: [HTTP_WORKLOAD],
      capacity: 1,
    }));
    const identity = (await repository.activate("manifest-worker-live")).attempt
      .identity;
    const authority = createInMemoryRegistrationAuthority();
    const registration = await authority.issueRegistration(identity);
    const hypervisor = createHypervisor({
      authority,
      repository,
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
    const listener = hypervisor.listen({
      hostname: "127.0.0.1",
      port: 0,
    });
    let runtimeA: ManifestWorkerRuntime | undefined;
    let runtimeB: ManifestWorkerRuntime | undefined;
    let mismatchedRuntime: ManifestWorkerRuntime | undefined;
    try {
      const routesRoot = join(root, "routes");
      await Deno.mkdir(routesRoot);
      await Deno.writeTextFile(
        join(routesRoot, "index.ts"),
        `export function GET(
  _request: Request,
  context: { state: { source: string } },
): Response {
  return new Response(context.state.source, {
    headers: { "content-type": "text/plain" },
  });
}
`,
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
    state: { source: "served-by-manifest-factory" },
    middleware: [
      async (_request, _context, next) => {
        const response = await next();
        return new Response((await response.text()) + ":middleware");
      },
    ],
  })
);
`,
      );
      await Deno.writeTextFile(
        join(root, "oxian.config.ts"),
        `export default {
  application: {
    routesRoot: "./routes",
    basePath: "/api",
    factory: "./application.ts",
  },
} as const;
`,
      );
      const gatewayUrl = new URL(
        hypervisor.config.workerPath,
        listener.url,
      );
      gatewayUrl.protocol = "ws:";
      const initialHandshakeId = crypto.randomUUID();
      const storePath = join(root, "state", "resume.json");
      await Deno.writeTextFile(
        join(root, "worker.ts"),
        `export default ${
          JSON.stringify(
            {
              gatewayUrl: gatewayUrl.href,
              identity,
              credential: registration.credential,
              handshakeId: initialHandshakeId,
              capacity: 1,
              applicationConfig: "./oxian.config.ts",
              credentialStore: {
                mode: "durable",
                path: "./state/resume.json",
              },
            },
            null,
            2,
          )
        } as const;
`,
      );

      const manifest = await loadWorkerManifest(join(root, "worker.ts"));
      runtimeA = createManifestWorkerRuntime({ manifest });
      const runningA = await runtimeA.start();
      assertEquals(runningA.application.basePath, "/api");
      assertEquals(runningA.application.state, {
        source: "served-by-manifest-factory",
      });
      await waitForReady(
        () =>
          hypervisor.sessions.get(identity.workerId)?.phase ===
            "ready",
      );
      const firstSession = hypervisor.sessions.get(identity.workerId);
      assert(firstSession !== undefined);

      const gateway = createHttpGateway({
        dispatch: hypervisor.dispatch,
      });
      const response = await gateway(
        new Request("https://gateway.example/api"),
      );
      assertEquals(response.status, 200);
      assertEquals(
        await response.text(),
        "served-by-manifest-factory:middleware",
      );
      assertEquals(
        (await gateway(
          new Request("https://gateway.example/apix"),
        )).status,
        404,
      );

      await runtimeA.stop("simulate_process_restart");
      await runtimeA.finished;
      await waitForReady(
        () => hypervisor.sessions.get(identity.workerId) === undefined,
      );
      const firstPersisted = JSON.parse(await Deno.readTextFile(storePath));
      assertEquals(firstPersisted.schema, "oxian.worker-resume.v1");
      assertEquals(firstPersisted.identity, identity);
      assertEquals(firstPersisted.credential.kind, "resume");
      assertNotEquals(firstPersisted.handshakeId, initialHandshakeId);

      // A fresh runtime instance receives the unchanged provisioned manifest.
      // The durable store, not the consumed registration in that manifest,
      // supplies its current resume credential and replacement handshake ID.
      runtimeB = createManifestWorkerRuntime({ manifest });
      const runningB = await runtimeB.start();
      assertEquals(runningB.application.basePath, "/api");
      await waitForReady(
        () =>
          hypervisor.sessions.get(identity.workerId)?.phase ===
            "ready",
      );
      const secondSession = hypervisor.sessions.get(identity.workerId);
      assert(secondSession !== undefined);
      assertEquals(secondSession.identity, identity);
      assertNotEquals(secondSession.connectionId, firstSession.connectionId);
      assert(
        secondSession.sessionGeneration > firstSession.sessionGeneration,
        "resumed process must receive a strictly newer session generation",
      );

      const resumedResponse = await gateway(
        new Request("https://gateway.example/api"),
      );
      assertEquals(resumedResponse.status, 200);
      assertEquals(
        await resumedResponse.text(),
        "served-by-manifest-factory:middleware",
      );

      await runtimeB.stop("test_complete");
      await runtimeB.finished;
      await waitForReady(
        () => hypervisor.sessions.get(identity.workerId) === undefined,
      );
      const secondPersisted = JSON.parse(await Deno.readTextFile(storePath));
      assertEquals(secondPersisted.identity, identity);
      assertEquals(secondPersisted.credential.kind, "resume");
      assertNotEquals(
        secondPersisted.handshakeId,
        firstPersisted.handshakeId,
      );

      mismatchedRuntime = createManifestWorkerRuntime({
        manifest: Object.freeze({
          ...manifest,
          identity: Object.freeze({
            ...manifest.identity,
            attemptId: `${manifest.identity.attemptId}-replacement`,
          }),
        }),
      });
      await assertRejects(
        () => mismatchedRuntime!.start(),
        TypeError,
        "resume credential store identity does not match the worker manifest",
      );
      assertEquals(mismatchedRuntime.snapshot().worker, undefined);
      assertEquals(hypervisor.snapshot().connections, 0);
    } finally {
      await mismatchedRuntime?.stop("test_cleanup").catch(() => undefined);
      await runtimeB?.stop("test_cleanup").catch(() => undefined);
      await runtimeA?.stop("test_cleanup").catch(() => undefined);
      await hypervisor.shutdown("test_cleanup").catch(() => undefined);
      await listener.shutdown().catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "manifest worker stop preempts an unreachable gateway startup",
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
      "export function GET(): Response { return new Response('ok'); }\n",
    );
    await Deno.writeTextFile(
      join(root, "oxian.config.ts"),
      'export default { application: { routesRoot: "./routes" } };\n',
    );
    const runtime = createManifestWorkerRuntime({
      manifest: Object.freeze({
        gatewayUrl: "ws://127.0.0.1:1/_oxian/workers/connect",
        identity: Object.freeze({
          workerId: "unreachable-worker",
          attemptId: "attempt-1",
          epoch: 1,
        }),
        credential: Object.freeze({
          kind: "registration",
          capability: "registration-secret",
        }),
        handshakeId: "handshake-1",
        capacity: 1,
        applicationConfig: new URL(
          `file://${join(root, "oxian.config.ts")}`,
        ).href,
        credentialStore: Object.freeze({ mode: "ephemeral" }),
      }),
    });
    const starting = runtime.start();
    try {
      const deadline = Date.now() + 1_000;
      while (runtime.snapshot().worker === undefined) {
        if (Date.now() >= deadline) {
          throw new DOMException("worker was not constructed", "TimeoutError");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      await withTimeout(runtime.stop("cancel_connect"));
      await runtime.finished;
      assertEquals(runtime.snapshot().state, "stopped");
      await assertRejects(() => withTimeout(starting));
    } finally {
      await runtime.stop("test_cleanup").catch(() => undefined);
      await starting.catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "manifest stop during the factory disposes its unclaimed application",
  permissions: {
    read: true,
    write: true,
  },
  async fn() {
    const root = await Deno.makeTempDir();
    const routesRoot = join(root, "routes");
    const disposeMarker = join(root, "application-disposed");
    const stopKey = `__oxian_manifest_stop_${crypto.randomUUID()}`;
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
    await Deno.writeTextFile(
      join(root, "oxian.config.ts"),
      `export default {
  application: {
    routesRoot: "./routes",
    factory: "./application.ts",
  },
};\n`,
    );
    const runtime = createManifestWorkerRuntime({
      manifest: Object.freeze({
        gatewayUrl: "ws://127.0.0.1:1/_oxian/workers/connect",
        identity: Object.freeze({
          workerId: "factory-stop-worker",
          attemptId: "attempt-1",
          epoch: 1,
        }),
        credential: Object.freeze({
          kind: "registration",
          capability: "registration-secret",
        }),
        handshakeId: "handshake-1",
        capacity: 1,
        applicationConfig: new URL(
          `file://${join(root, "oxian.config.ts")}`,
        ).href,
        credentialStore: Object.freeze({ mode: "ephemeral" }),
      }),
    });
    let stopTask: Promise<void> | undefined;
    Object.defineProperty(globalThis, stopKey, {
      configurable: true,
      value: () => {
        stopTask ??= runtime.stop("factory_requested_stop");
      },
    });
    const starting = runtime.start();

    try {
      await assertRejects(() => withTimeout(starting));
      await withTimeout(
        stopTask ??
          Promise.reject(new Error("factory did not request runtime stop")),
      );
      await runtime.finished;
      assertEquals(runtime.snapshot().state, "stopped");
      assertEquals(await Deno.readTextFile(disposeMarker), "disposed");
    } finally {
      Reflect.deleteProperty(globalThis, stopKey);
      await runtime.stop("test_cleanup").catch(() => undefined);
      await starting.catch(() => undefined);
      await Deno.remove(root, { recursive: true });
    }
  },
});
