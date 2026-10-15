import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import { CLI_USAGE, parseCliArgs, runCli } from "../../src/cli/index.ts";
import { defineConfig } from "../../src/config/index.ts";
import type {
  LocalRuntimeRunning,
  ManifestWorkerRuntimeRunning,
  WorkerManifest,
} from "../../src/local/types.ts";

test("v0.20 parser accepts only the exact command-specific surface", () => {
  assert.deepStrictEqual(
    parseCliArgs([
      "dev",
      "--config",
      "custom.config.ts",
      "--hostname=localhost",
      "--port",
      "0",
    ]),
    {
      command: "dev",
      help: false,
      config: "custom.config.ts",
      hostname: "localhost",
      port: 0,
    },
  );
  assert.deepStrictEqual(parseCliArgs(["init", "--root=project", "--force"]), {
    command: "init",
    help: false,
    force: true,
    root: "project",
  });
  assert.deepStrictEqual(parseCliArgs(["worker", "--manifest=worker.ts"]), {
    command: "worker",
    help: false,
    manifest: "worker.ts",
  });

  for (const args of [
    [] as string[],
    ["serve"],
    ["start", "--source=."],
    ["start", "--hypervisor=false"],
    ["start", "--materialize"],
    ["start", "--port=-1"],
    ["start", "--port=65536"],
    ["start", "--port=01"],
    ["start", "--config=config.json"],
    ["worker", "--manifest=https://example.com/worker.ts"],
    ["init", "--force=true"],
    ["check", "extra"],
    ["routes", "--config"],
    ["routes", "--config=a.ts", "--config=b.ts"],
  ]) {
    assertThrows(() => parseCliArgs(args));
  }
});

test("v0.20 CLI help, input failures, and runtime failures map to 0/2/1", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
  };

  assert.deepStrictEqual(await runCli(["--help"], { io }), 0);
  assert.deepStrictEqual(stdout, [CLI_USAGE]);
  assert.deepStrictEqual(stderr.length, 0);

  stdout.length = 0;
  assert.deepStrictEqual(await runCli(["unknown"], { io }), 2);
  assert.ok(stderr[0].includes("unknown command"));
  assert.ok(stderr[0].includes("Usage:"));

  stderr.length = 0;
  assert.deepStrictEqual(
    await runCli(["check"], {
      io,
      cwd: () => "/virtual/project",
      loadConfig: () => Promise.reject(new Error("config exploded")),
    }),
    1,
  );
  assert.deepStrictEqual(stderr, ["error: config exploded"]);
});

test("dev and worker commands own and stop their injected lifecycles", async () => {
  const stdout: string[] = [];
  let serverStops = 0;
  let workerStops = 0;
  let observedMode: string | undefined;
  const config = defineConfig({
    application: { routesRoot: "/virtual/routes" },
    gateway: { listener: { port: 0 } },
  });

  assert.deepStrictEqual(
    await runCli(["dev", "--config=oxian.config.ts"], {
      io: {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
      },
      loadConfig: () => Promise.resolve(config),
      createLocalRuntime: (options) => {
        observedMode = options.mode;
        return Object.freeze({
          start: () =>
            Promise.resolve({
              listenerUrl: new URL("http://127.0.0.1:4321/"),
            } as LocalRuntimeRunning),
          stop: () => {
            serverStops++;
            return Promise.resolve();
          },
          finished: new Promise<void>(() => undefined),
          snapshot: () => Object.freeze({ state: "running" as const }),
        });
      },
      waitForLifecycle: () => Promise.resolve(),
    }),
    0,
  );
  assert.deepStrictEqual(observedMode, "dev");
  assert.deepStrictEqual(serverStops, 1);
  assert.ok(stdout[0].includes("http://127.0.0.1:4321/"));

  const manifest: WorkerManifest = Object.freeze({
    gatewayUrl: "wss://gateway.example/workers",
    identity: Object.freeze({
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 1,
    }),
    credential: Object.freeze({
      kind: "registration",
      capability: "secret",
    }),
    handshakeId: "handshake-1",
    capacity: 1,
    applicationConfig: "file:///virtual/oxian.config.ts",
    credentialStore: Object.freeze({ mode: "ephemeral" }),
  });
  assert.deepStrictEqual(
    await runCli(["worker"], {
      io: {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined,
      },
      loadWorkerManifest: () => Promise.resolve(manifest),
      createManifestWorkerRuntime: () =>
        Object.freeze({
          start: () => Promise.resolve({} as ManifestWorkerRuntimeRunning),
          stop: () => {
            workerStops++;
            return Promise.resolve();
          },
          finished: new Promise<void>(() => undefined),
          snapshot: () => Object.freeze({ state: "running" as const }),
        }),
      waitForLifecycle: () => Promise.resolve(),
    }),
    0,
  );
  assert.deepStrictEqual(workerStops, 1);
  assert.ok(stdout.some((line) => line.includes("worker worker-1 is ready")));
});
