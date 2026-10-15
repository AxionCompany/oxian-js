import { test } from "node:test";
import assert from "node:assert/strict";
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

test("package root is exactly the portable execution core", () => {
  assert.deepStrictEqual(Object.keys(root), Object.keys(core));
  assert.deepStrictEqual(root.createApplication, app.createApplication);
  assert.deepStrictEqual(root.createHttpGateway, http.createHttpGateway);
  assert.deepStrictEqual(root.createHypervisor, hypervisor.createHypervisor);
  assert.deepStrictEqual(root.createWorker, worker.createWorker);
  assert.deepStrictEqual(root.WORKER_PROTOCOL, protocol.WORKER_PROTOCOL);
  assert.deepStrictEqual(
    root.createExternallyAttachedProvider,
    providers.createExternallyAttachedProvider,
  );
  assert.deepStrictEqual(
    root.createCloudRunJobsProvider,
    providers.createCloudRunJobsProvider,
  );
  assert.deepStrictEqual("createEphemeralWorkerStore" in root, false);
  assert.deepStrictEqual("createEphemeralCredentialLifecycle" in root, false);
  assert.deepStrictEqual("connectWorkerWebSocket" in root, false);
  assert.deepStrictEqual(typeof transport.connectWorkerWebSocket, "function");

  for (const platformExport of [
    "defineConfig",
    "createCorsAdapter",
    "createFileRouter",
    "createLocalProcessProvider",
    "createLocalRuntime",
    "serve",
  ]) {
    assert.deepStrictEqual(platformExport in root, false);
  }

  assert.deepStrictEqual(typeof config.defineConfig, "function");
  assert.deepStrictEqual(typeof edge.createCorsAdapter, "function");
  assert.deepStrictEqual(typeof local.createLocalRuntime, "function");
  assert.deepStrictEqual(
    typeof providers.createLocalProcessProvider,
    "function",
  );
  assert.deepStrictEqual(typeof router.createFileRouter, "function");
  assert.deepStrictEqual(typeof denoAdapter.handler, "function");
  assert.deepStrictEqual(typeof denoAdapter.serve, "function");
});

test("CLI is an explicit embeddable subpath", () => {
  assert.deepStrictEqual(typeof cli.runCli, "function");
  assert.deepStrictEqual(typeof cli.parseCliArgs, "function");
  assert.deepStrictEqual("runCli" in root, false);
});
