import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createExternallyAttachedProvider,
  createProviderResource,
  isProviderError,
  runProviderConformance,
} from "../../src/providers/index.ts";
import type { ProviderResource } from "../../src/providers/index.ts";

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
        attemptId: `${resource.identity.attemptId}-stale`,
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

Deno.test("externally attached provider passes generic conformance", async () => {
  let clock = 1_000;
  const provider = createExternallyAttachedProvider({
    now: () => clock++,
    createResourceId: () => "attachment-resource-1",
  });

  const report = await runProviderConformance({
    provider,
    launch: {
      attachmentId: "compass-device-1",
      attributes: {
        platform: "darwin",
      },
    },
  });

  assertEquals(report.checks, [
    "pre-aborted provision",
    "provision",
    "resource identity",
    "session-independent resource",
    "inspect present",
    "pre-aborted inspect",
    "pre-aborted terminate",
    "terminate",
    "inspect absent",
    "idempotent terminate",
  ]);
  assertEquals(report.resource.attributes, {
    attachmentId: "compass-device-1",
    platform: "darwin",
  });
  assertEquals(report.initialInspection.state, "present");
  assertEquals(report.finalInspection.state, "absent");
  await assertTamperedReferencesRejected(provider, report.resource);
});

Deno.test("externally attached presence does not imply a ready session", async () => {
  const provider = createExternallyAttachedProvider({
    createResourceId: () => "detached-computer",
  });
  const resource = await provider.provision({
    identity: {
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 3,
    },
    launch: {
      attachmentId: "computer-1",
    },
  });

  try {
    assertEquals((await provider.inspect(resource)).state, "present");
    assertEquals("ready" in resource, false);
    assertEquals("connectionId" in resource, false);
    assertEquals("session" in resource, false);
  } finally {
    await provider.terminate(resource);
  }
});

Deno.test("externally attached reservations rehydrate across process restarts", async () => {
  const first = createExternallyAttachedProvider({
    providerId: "external",
    now: () => 42,
    createResourceId: () => "durable-reservation",
  });
  const resource = await first.provision({
    identity: {
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 3,
    },
    launch: {
      attachmentId: "computer-1",
      attributes: { platform: "darwin" },
    },
  });

  const afterRestart = createExternallyAttachedProvider({
    providerId: "external",
    now: () => 84,
  });
  const durableInput = {
    resourceId: resource.resourceId,
    identity: resource.identity,
    attachmentId: "computer-1",
    createdAtMs: resource.createdAtMs,
    attributes: resource.attributes,
  };
  const rehydrated = afterRestart.rehydrateResource(durableInput);

  assertEquals(rehydrated, resource);
  assertEquals(afterRestart.rehydrateResource(durableInput), resource);
  assertEquals((await afterRestart.inspect(rehydrated)).state, "present");
  assertEquals(
    (await afterRestart.terminate(rehydrated)).outcome,
    "terminated",
  );
  assertEquals((await afterRestart.inspect(rehydrated)).state, "absent");
  assertEquals(
    (await afterRestart.terminate(rehydrated)).outcome,
    "already_absent",
  );

  afterRestart.rehydrateResource(durableInput);
  assertEquals(
    (await afterRestart.inspect(rehydrated)).state,
    "absent",
  );
});

Deno.test("externally attached rehydration rejects conflicting durable references", () => {
  const provider = createExternallyAttachedProvider({
    providerId: "external",
  });
  const durableInput = {
    resourceId: "durable-reservation",
    identity: {
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 3,
    },
    attachmentId: "computer-1",
    createdAtMs: 42,
    attributes: { platform: "darwin" },
  } as const;

  provider.rehydrateResource(durableInput);
  const error = assertThrows(
    () =>
      provider.rehydrateResource({
        ...durableInput,
        attachmentId: "computer-2",
      }),
    Error,
  );
  assertEquals(isProviderError(error), true);
  if (isProviderError(error)) {
    assertEquals(error.code, "invalid_resource");
  }
});

Deno.test("providers reject resources owned by another provider", async () => {
  const provider = createExternallyAttachedProvider({
    providerId: "external-a",
  });
  const foreignResource = createProviderResource({
    providerId: "external-b",
    resourceId: "resource-1",
    identity: {
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 1,
    },
    createdAtMs: 1,
  });

  const error = await assertRejects(
    () => provider.inspect(foreignResource),
    Error,
  );
  assertEquals(isProviderError(error), true);
  if (isProviderError(error)) {
    assertEquals(error.code, "invalid_resource");
    assertEquals(error.providerId, "external-a");
  }
});

Deno.test("unknown externally attached resources remain explicit", async () => {
  const provider = createExternallyAttachedProvider({
    providerId: "external",
  });
  const missing = createProviderResource({
    providerId: "external",
    resourceId: "never-reserved",
    identity: {
      workerId: "worker-1",
      attemptId: "attempt-1",
      epoch: 1,
    },
    createdAtMs: 1,
  });

  assertEquals((await provider.inspect(missing)).state, "unknown");
  assertEquals((await provider.terminate(missing)).outcome, "unknown");
});
