import { assertEquals } from "@std/assert";
import * as denoAdapter from "@oxian/oxian-js/adapters/deno";
import * as root from "@oxian/oxian-js";
import * as app from "@oxian/oxian-js/app";
import * as cli from "@oxian/oxian-js/cli";
import * as config from "@oxian/oxian-js/config";
import * as core from "../../src/core.ts";
import * as edge from "@oxian/oxian-js/edge";
import * as http from "@oxian/oxian-js/http";
import * as hypervisor from "@oxian/oxian-js/hypervisor";
import * as local from "@oxian/oxian-js/local";
import * as protocol from "@oxian/oxian-js/protocol";
import * as providers from "@oxian/oxian-js/providers";
import * as router from "@oxian/oxian-js/router";
import * as transport from "@oxian/oxian-js/transport";
import * as worker from "@oxian/oxian-js/worker";

Deno.test("package root is exactly the portable execution core", () => {
  assertEquals(Object.keys(root), Object.keys(core));
  assertEquals(root.createApplication, app.createApplication);
  assertEquals(root.createHttpGateway, http.createHttpGateway);
  assertEquals(root.createHypervisor, hypervisor.createHypervisor);
  assertEquals(root.createWorker, worker.createWorker);
  assertEquals(root.WORKER_PROTOCOL, protocol.WORKER_PROTOCOL);
  assertEquals(
    root.createExternallyAttachedProvider,
    providers.createExternallyAttachedProvider,
  );
  assertEquals(
    root.createCloudRunJobsProvider,
    providers.createCloudRunJobsProvider,
  );
  assertEquals("createEphemeralWorkerStore" in root, false);
  assertEquals("createEphemeralCredentialLifecycle" in root, false);
  assertEquals("connectWorkerWebSocket" in root, false);
  assertEquals(typeof transport.connectWorkerWebSocket, "function");

  for (
    const platformExport of [
      "defineConfig",
      "createCorsAdapter",
      "createFileRouter",
      "createLocalProcessProvider",
      "createLocalRuntime",
      "serve",
    ]
  ) {
    assertEquals(platformExport in root, false);
  }

  assertEquals(typeof config.defineConfig, "function");
  assertEquals(typeof edge.createCorsAdapter, "function");
  assertEquals(typeof local.createLocalRuntime, "function");
  assertEquals(typeof providers.createLocalProcessProvider, "function");
  assertEquals(typeof router.createFileRouter, "function");
  assertEquals(typeof denoAdapter.handler, "function");
  assertEquals(typeof denoAdapter.serve, "function");
});

Deno.test("CLI is an explicit embeddable subpath", () => {
  assertEquals(typeof cli.runCli, "function");
  assertEquals(typeof cli.parseCliArgs, "function");
  assertEquals("runCli" in root, false);
});
