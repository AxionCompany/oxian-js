import { assertEquals } from "@std/assert";
import {
  createHttpGateway,
  createHttpWorkload,
  HTTP_WORKLOAD,
} from "../../src/http/index.ts";
import { createHypervisor } from "../../src/hypervisor/index.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "../../src/supervisor/index.ts";
import {
  createWorkerClient,
  type WorkerClientResult,
} from "../../src/worker/index.ts";

/**
 * This test intentionally relies on certificate validation. Run it with:
 *
 * deno test --cert=tests/fixtures/tls/test-ca.pem \
 *   --allow-net=127.0.0.1 --allow-read=tests/fixtures/tls \
 *   tests/http/wss_tls_integration_test.ts
 */

const TEST_TIMEOUT_MS = 5_000;
const TLS_FIXTURE_DIRECTORY = new URL("../fixtures/tls/", import.meta.url);

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
  address: Readonly<{ port: number }>,
  workerPath: string,
): URL {
  const url = new URL(
    workerPath,
    `https://127.0.0.1:${address.port}`,
  );
  url.protocol = "wss:";
  return url;
}

const [loopbackPermission, fixturePermission] = await Promise.all([
  Deno.permissions.query({
    name: "net",
    host: "127.0.0.1",
  }),
  Deno.permissions.query({
    name: "read",
    path: TLS_FIXTURE_DIRECTORY,
  }),
]);

Deno.test({
  name:
    "HTTP workload round-trips through a certificate-verified TLS WSS worker",
  ignore: loopbackPermission.state !== "granted" ||
    fixturePermission.state !== "granted",
  async fn() {
    const [certificate, privateKey] = await Promise.all([
      Deno.readTextFile(new URL("server.pem", TLS_FIXTURE_DIRECTORY)),
      Deno.readTextFile(new URL("server.key", TLS_FIXTURE_DIRECTORY)),
    ]);
    const repository = createInMemoryWorkerRepository();
    await repository.define(createWorkerDefinition({
      workerId: "http-tls-wss-worker",
      providerId: "attached",
      workloads: [HTTP_WORKLOAD],
      capacity: 1,
    }));
    const identity = (await repository.activate("http-tls-wss-worker"))
      .attempt.identity;
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
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      cert: certificate,
      key: privateKey,
      onListen() {},
    }, hypervisor.fetch);
    const url = workerUrl(server.addr, hypervisor.config.workerPath);
    assertEquals(url.protocol, "wss:");
    const worker = createWorkerClient({
      url,
      identity,
      credential: registration.credential,
      credentialPersistence: "ephemeral",
      workloads: {
        [HTTP_WORKLOAD]: createHttpWorkload({
          fetch: async (request) => {
            assertEquals(request.method, "POST");
            assertEquals(
              request.url,
              "https://application.test/tls-round-trip",
            );
            assertEquals(request.headers.get("x-oxian-test"), "tls-wss");
            const input = await request.text();
            return new Response(`received:${input}`, {
              status: 202,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                "x-oxian-transport": "tls-wss",
              },
            });
          },
        }),
      },
      capacity: 1,
      reconnectDelay: false,
      connectTimeoutMs: 1_000,
      handshakeTimeoutMs: 1_000,
    });
    let workerRun: Promise<WorkerClientResult> | undefined;

    try {
      workerRun = worker.run();
      await withTimeout(
        worker.whenReady(),
        "TLS WSS worker did not become ready",
      );
      await waitFor(
        () => hypervisor.sessions.get(identity.workerId)?.phase === "ready",
        "Hypervisor did not publish the TLS WSS worker session",
      );
      const gateway = createHttpGateway({
        dispatch: hypervisor.dispatch,
        createRequestId: () => "tls-wss-request",
      });
      const response = await withTimeout(
        gateway(
          new Request("https://application.test/tls-round-trip", {
            method: "POST",
            headers: { "x-oxian-test": "tls-wss" },
            body: "payload",
          }),
        ),
        "HTTP response metadata did not arrive over TLS WSS",
      );

      assertEquals(response.status, 202);
      assertEquals(response.headers.get("x-oxian-transport"), "tls-wss");
      assertEquals(
        await withTimeout(
          response.text(),
          "HTTP response body did not arrive over TLS WSS",
        ),
        "received:payload",
      );
    } finally {
      await hypervisor.shutdown("test_cleanup").catch(() => undefined);
      await worker.stop("test_cleanup").catch(() => undefined);
      await server.shutdown().catch(() => undefined);
      await workerRun?.catch(() => undefined);
    }
  },
});
