import { assertEquals, assertRejects } from "@std/assert";
import {
  createLocalProcessProvider,
  isProviderError,
  runProviderConformance,
} from "../../src/providers/index.ts";
import type { ProviderResource } from "../../src/providers/index.ts";

const fixtureUrl = new URL("./fixtures/local_worker.ts", import.meta.url);

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertTamperedReferencesRejected(
  provider: {
    inspect(resource: ProviderResource): Promise<unknown>;
    terminate(resource: ProviderResource): Promise<unknown>;
  },
  resource: ProviderResource,
): Promise<void> {
  const tamperedResources: ProviderResource[] = [
    {
      ...resource,
      identity: {
        ...resource.identity,
        epoch: resource.identity.epoch + 1,
      },
    },
    {
      ...resource,
      createdAtMs: resource.createdAtMs + 1,
    },
    {
      ...resource,
      attributes: {
        ...resource.attributes,
        tampered: true,
      },
    },
  ];

  for (const tampered of tamperedResources) {
    for (
      const operation of [
        () => provider.inspect(tampered),
        () => provider.terminate(tampered),
      ]
    ) {
      const error = await assertRejects(operation, Error);
      assertEquals(isProviderError(error), true);
      if (isProviderError(error)) {
        assertEquals(error.code, "invalid_resource");
      }
    }
  }
}

Deno.test({
  name: "local process provider passes conformance with a real child",
  permissions: {
    run: true,
  },
  async fn() {
    const provider = createLocalProcessProvider({
      createResourceId: () => "local-conformance-child",
      defaultGracePeriodMs: 500,
    });

    const report = await runProviderConformance({
      provider,
      launch: {
        command: Deno.execPath(),
        args: [
          "eval",
          "setInterval(() => {}, 60000); await new Promise(() => {});",
        ],
        stdout: "null",
        stderr: "null",
      },
    });

    assertEquals(report.initialInspection.state, "present");
    assertEquals(report.termination.outcome, "terminated");
    assertEquals(report.finalInspection.state, "absent");
    assertEquals(
      typeof report.initialInspection.details.pid,
      "number",
    );
    await assertTamperedReferencesRejected(
      provider,
      report.resource,
    );
  },
});

Deno.test({
  name: "local process provider passes explicit args, env, and cwd",
  permissions: {
    env: ["OXIAN_PROVIDER_TEST_INHERITED"],
    read: true,
    run: true,
    write: true,
  },
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "oxian-provider-test-",
    });
    const markerPath = `${directory}/marker.json`;
    const expectedArgument = "expected-argument";
    Deno.env.set(
      "OXIAN_PROVIDER_TEST_INHERITED",
      "must-not-reach-the-child",
    );
    const provider = createLocalProcessProvider({
      createResourceId: () => "explicit-launch-child",
      defaultGracePeriodMs: 500,
    });
    const resource = await provider.provision({
      identity: {
        workerId: "worker-explicit",
        attemptId: "attempt-explicit",
        epoch: 1,
      },
      launch: {
        command: Deno.execPath(),
        args: [
          "run",
          `--allow-env=OXIAN_PROVIDER_TEST_MARKER,OXIAN_PROVIDER_TEST_ARGUMENT,OXIAN_PROVIDER_TEST_IGNORE_SIGTERM,OXIAN_PROVIDER_TEST_INHERITED`,
          `--allow-write=${directory}`,
          fixtureUrl.toString(),
          expectedArgument,
        ],
        cwd: directory,
        env: {
          OXIAN_PROVIDER_TEST_ARGUMENT: expectedArgument,
          OXIAN_PROVIDER_TEST_MARKER: markerPath,
        },
        stdout: "null",
        stderr: "null",
      },
    });

    try {
      await waitFor(async () => {
        try {
          await Deno.stat(markerPath);
          return true;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return false;
          throw error;
        }
      });

      const marker = JSON.parse(await Deno.readTextFile(markerPath));
      assertEquals(marker, {
        argument: expectedArgument,
        cwd: await Deno.realPath(directory),
        env: expectedArgument,
        ignoresSigterm: false,
        inheritedSentinel: null,
      });
      assertEquals((await provider.inspect(resource)).state, "present");
    } finally {
      Deno.env.delete("OXIAN_PROVIDER_TEST_INHERITED");
      await provider.terminate(resource, {
        gracePeriodMs: 500,
      });
      await Deno.remove(directory, { recursive: true });
    }

    assertEquals((await provider.inspect(resource)).state, "absent");
  },
});

Deno.test({
  name: "local process provider reports unexpected non-zero exits",
  permissions: {
    run: true,
  },
  async fn() {
    const provider = createLocalProcessProvider({
      createResourceId: () => "failed-child",
    });
    const resource = await provider.provision({
      identity: {
        workerId: "worker-failure",
        attemptId: "attempt-failure",
        epoch: 1,
      },
      launch: {
        command: Deno.execPath(),
        args: ["eval", "Deno.exit(23);"],
        stdout: "null",
        stderr: "null",
      },
    });

    await waitFor(async () =>
      (await provider.inspect(resource)).state === "failed"
    );
    const inspection = await provider.inspect(resource);
    assertEquals(inspection.state, "failed");
    assertEquals(inspection.details.exitCode, 23);
    assertEquals(
      (await provider.terminate(resource)).outcome,
      "already_absent",
    );
  },
});

Deno.test("local process provider rejects invalid launch specs before spawning", async () => {
  const provider = createLocalProcessProvider();
  const error = await assertRejects(
    () =>
      provider.provision({
        identity: {
          workerId: "worker-invalid",
          attemptId: "attempt-invalid",
          epoch: 1,
        },
        launch: {
          command: "",
        },
      }),
    Error,
  );

  assertEquals(isProviderError(error), true);
  if (isProviderError(error)) {
    assertEquals(error.code, "invalid_launch_spec");
  }
});

Deno.test("local process provider reports rejected child status as unknown", async () => {
  const signals: Array<Deno.Signal | undefined> = [];
  const provider = createLocalProcessProvider({
    createResourceId: () => "rejected-status-child",
    spawnProcess: () => ({
      pid: 44_001,
      status: Promise.reject(new Error("status channel failed")),
      kill: (signal) => signals.push(signal),
    }),
  });
  const resource = await provider.provision({
    identity: {
      workerId: "worker-status-error",
      attemptId: "attempt-status-error",
      epoch: 1,
    },
    launch: {
      command: "fake-worker",
    },
  });

  await Promise.resolve();
  assertEquals((await provider.inspect(resource)).state, "unknown");
  const error = await assertRejects(
    () => provider.terminate(resource),
    Error,
  );
  assertEquals(isProviderError(error), true);
  if (isProviderError(error)) {
    assertEquals(error.code, "termination_failed");
    assertEquals(
      (error.cause as Error).message,
      "status channel failed",
    );
  }
  assertEquals(signals, ["SIGKILL"]);
});

Deno.test("local process forced termination has a bounded status wait", async () => {
  const signals: Array<Deno.Signal | undefined> = [];
  const provider = createLocalProcessProvider({
    createResourceId: () => "stuck-status-child",
    defaultGracePeriodMs: 0,
    forceExitTimeoutMs: 20,
    spawnProcess: () => ({
      pid: 44_002,
      status: new Promise<Deno.CommandStatus>(() => {}),
      kill: (signal) => signals.push(signal),
    }),
  });
  const resource = await provider.provision({
    identity: {
      workerId: "worker-stuck-status",
      attemptId: "attempt-stuck-status",
      epoch: 1,
    },
    launch: {
      command: "fake-worker",
    },
  });

  const startedAt = performance.now();
  const error = await assertRejects(
    () => provider.terminate(resource),
    Error,
  );
  assertEquals(isProviderError(error), true);
  if (isProviderError(error)) {
    assertEquals(error.code, "termination_failed");
  }
  assertEquals(signals, ["SIGTERM", "SIGKILL"]);
  assertEquals(performance.now() - startedAt < 1_000, true);
});

Deno.test({
  name: "local process provider force-kills a real child that ignores SIGTERM",
  permissions: {
    read: true,
    run: true,
    write: true,
  },
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "oxian-provider-force-test-",
    });
    const markerPath = `${directory}/marker.json`;
    const provider = createLocalProcessProvider({
      createResourceId: () => "sigterm-resistant-child",
      defaultGracePeriodMs: 30,
      forceExitTimeoutMs: 1_000,
    });
    const resource = await provider.provision({
      identity: {
        workerId: "worker-force",
        attemptId: "attempt-force",
        epoch: 1,
      },
      launch: {
        command: Deno.execPath(),
        args: [
          "run",
          `--allow-env=OXIAN_PROVIDER_TEST_MARKER,OXIAN_PROVIDER_TEST_ARGUMENT,OXIAN_PROVIDER_TEST_IGNORE_SIGTERM,OXIAN_PROVIDER_TEST_INHERITED`,
          `--allow-write=${directory}`,
          fixtureUrl.toString(),
          "force-test",
        ],
        cwd: directory,
        env: {
          OXIAN_PROVIDER_TEST_ARGUMENT: "force-test",
          OXIAN_PROVIDER_TEST_IGNORE_SIGTERM: "true",
          OXIAN_PROVIDER_TEST_MARKER: markerPath,
        },
        stdout: "null",
        stderr: "null",
      },
    });

    try {
      await waitFor(async () => {
        try {
          await Deno.stat(markerPath);
          return true;
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return false;
          throw error;
        }
      });

      const startedAt = performance.now();
      const termination = await provider.terminate(resource);
      assertEquals(termination.outcome, "terminated");
      assertEquals(termination.details.signal, "SIGKILL");
      assertEquals(performance.now() - startedAt < 2_000, true);
      assertEquals((await provider.inspect(resource)).state, "absent");
    } finally {
      await provider.terminate(resource).catch(() => {});
      await Deno.remove(directory, { recursive: true });
    }
  },
});
