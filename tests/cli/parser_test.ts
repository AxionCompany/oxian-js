import { assert, assertEquals, assertThrows } from "@std/assert";
import { CLI_USAGE, parseCliArgs, runCli } from "../../src/cli/index.ts";
import { defineConfig } from "../../src/config/index.ts";
import type {
  LocalRuntimeRunning,
  ManifestWorkerRuntimeRunning,
  WorkerManifest,
} from "../../src/local/types.ts";

Deno.test("v0.20 parser accepts only the exact command-specific surface", () => {
  assertEquals(
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
  assertEquals(
    parseCliArgs([
      "init",
      "--root=project",
      "--force",
    ]),
    {
      command: "init",
      help: false,
      force: true,
      root: "project",
    },
  );
  assertEquals(
    parseCliArgs([
      "worker",
      "--manifest=worker.ts",
    ]),
    {
      command: "worker",
      help: false,
      manifest: "worker.ts",
    },
  );

  for (
    const args of [
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
    ]
  ) {
    assertThrows(() => parseCliArgs(args));
  }
});

Deno.test("v0.20 CLI help, input failures, and runtime failures map to 0/2/1", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io = {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
  };

  assertEquals(await runCli(["--help"], { io }), 0);
  assertEquals(stdout, [CLI_USAGE]);
  assertEquals(stderr, []);

  stdout.length = 0;
  assertEquals(await runCli(["unknown"], { io }), 2);
  assert(stderr[0].includes("unknown command"));
  assert(stderr[0].includes("Usage:"));

  stderr.length = 0;
  assertEquals(
    await runCli(["check"], {
      io,
      cwd: () => "/virtual/project",
      loadConfig: () => Promise.reject(new Error("config exploded")),
    }),
    1,
  );
  assertEquals(stderr, ["error: config exploded"]);
});

Deno.test("dev and worker commands own and stop their injected lifecycles", async () => {
  const stdout: string[] = [];
  let serverStops = 0;
  let workerStops = 0;
  let observedMode: string | undefined;
  const config = defineConfig({
    application: { routesRoot: "/virtual/routes" },
    gateway: { listener: { port: 0 } },
  });

  assertEquals(
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
  assertEquals(observedMode, "dev");
  assertEquals(serverStops, 1);
  assert(stdout[0].includes("http://127.0.0.1:4321/"));

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
  assertEquals(
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
  assertEquals(workerStops, 1);
  assert(stdout.some((line) => line.includes("worker worker-1 is ready")));
});
