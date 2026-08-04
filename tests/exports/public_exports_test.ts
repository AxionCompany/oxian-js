import { assertEquals } from "@std/assert";
import * as root from "@oxian/oxian-js";
import * as app from "@oxian/oxian-js/app";
import * as cli from "@oxian/oxian-js/cli";
import * as config from "@oxian/oxian-js/config";
import * as edge from "@oxian/oxian-js/edge";
import * as http from "@oxian/oxian-js/http";
import * as host from "@oxian/oxian-js/host";
import * as hypervisor from "@oxian/oxian-js/hypervisor";
import * as local from "@oxian/oxian-js/local";
import * as protocol from "@oxian/oxian-js/protocol";
import * as providers from "@oxian/oxian-js/providers";
import * as router from "@oxian/oxian-js/router";
import * as supervisor from "@oxian/oxian-js/supervisor";
import * as transport from "@oxian/oxian-js/transport";
import * as worker from "@oxian/oxian-js/worker";

Deno.test("package root is the side-effect-free aggregate library surface", () => {
  assertEquals(root.createApplication, app.createApplication);
  assertEquals(
    root.defineApplicationFactory,
    app.defineApplicationFactory,
  );
  assertEquals(
    root.loadApplicationFactory,
    app.loadApplicationFactory,
  );
  assertEquals(root.defineConfig, config.defineConfig);
  assertEquals(root.createCorsAdapter, edge.createCorsAdapter);
  assertEquals(root.createHttpGateway, http.createHttpGateway);
  assertEquals(root.createWorkerHost, host.createWorkerHost);
  assertEquals(root.createHypervisor, hypervisor.createHypervisor);
  assertEquals(root.createLocalRuntime, local.createLocalRuntime);
  assertEquals(root.WORKER_PROTOCOL, protocol.WORKER_PROTOCOL);
  assertEquals(
    root.createExternallyAttachedProvider,
    providers.createExternallyAttachedProvider,
  );
  assertEquals(
    root.createCloudRunJobsProvider,
    providers.createCloudRunJobsProvider,
  );
  assertEquals(root.createFileRouter, router.createFileRouter);
  assertEquals(
    root.createInMemoryWorkerRepository,
    supervisor.createInMemoryWorkerRepository,
  );
  assertEquals(
    root.connectWorkerWebSocket,
    transport.connectWorkerWebSocket,
  );
  assertEquals(root.createWorkerClient, worker.createWorkerClient);
});

Deno.test("CLI is an explicit embeddable subpath", () => {
  assertEquals(typeof cli.runCli, "function");
  assertEquals(typeof cli.parseCliArgs, "function");
  assertEquals("runCli" in root, false);
});
