import { assertEquals, assertThrows } from "@std/assert";
import {
  createHypervisor,
  type WorkerAdmissionAuthority,
  type WorkerAdmissionRepository,
} from "../../src/hypervisor/index.ts";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
} from "../../src/supervisor/index.ts";

Deno.test("portable Hypervisor prepares responses and cancellable upgrade admissions", async () => {
  const authority = createInMemoryRegistrationAuthority();
  const repository = createInMemoryWorkerRepository();
  const hypervisor = createHypervisor({
    admission: { type: "registered", authority, repository },
    persistAcceptance: () => Promise.resolve(),
    fallback: () => new Response("fallback", { status: 202 }),
  });

  const fallback = hypervisor.prepare(
    new Request("https://example.test/not-a-worker"),
  );
  if (fallback.kind !== "response") {
    throw new Error("expected a normal HTTP response decision");
  }
  const response = await fallback.response;
  assertEquals(response.status, 202);
  assertEquals(await response.text(), "fallback");

  const admission = hypervisor.prepare(
    new Request(
      "https://example.test/_oxian/workers/connect",
      {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "oxian.worker.v1",
        },
      },
    ),
  );
  if (admission.kind !== "upgrade") {
    throw new Error("expected a WebSocket upgrade decision");
  }
  assertEquals(admission.protocol, "oxian.worker.v1");
  assertEquals(hypervisor.snapshot().connections, 1);
  admission.cancel("test_upgrade_failure");
  assertEquals(hypervisor.snapshot().connections, 0);
  await hypervisor.shutdown();
});

Deno.test("Hypervisor admission accepts exchange-only authority and read-only repository projections", () => {
  const authority = createInMemoryRegistrationAuthority();
  const repository = createInMemoryWorkerRepository();
  const admissionAuthority: WorkerAdmissionAuthority = Object.freeze({
    exchange: authority.exchange,
  });
  const admissionRepository: WorkerAdmissionRepository = Object.freeze({
    getDefinition: repository.getDefinition,
    assertCurrent: repository.assertCurrent,
  });
  const hypervisor = createHypervisor({
    admission: {
      type: "registered",
      authority: admissionAuthority,
      repository: admissionRepository,
    },
    persistAcceptance: () => Promise.resolve(),
  });

  assertEquals(Object.keys(admissionAuthority), ["exchange"]);
  assertEquals(Object.keys(admissionRepository).sort(), [
    "assertCurrent",
    "getDefinition",
  ]);
  assertEquals(hypervisor.snapshot().connections, 0);
});

Deno.test("Hypervisor rejects malformed admission seams during construction", () => {
  const authority = createInMemoryRegistrationAuthority();
  const repository = createInMemoryWorkerRepository();
  const valid = {
    admission: {
      type: "registered" as const,
      authority: { exchange: authority.exchange },
      repository: {
        getDefinition: repository.getDefinition,
        assertCurrent: repository.assertCurrent,
      },
    },
    persistAcceptance: () => Promise.resolve(),
  };

  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        admission: {
          ...valid.admission,
          authority: {} as WorkerAdmissionAuthority,
        },
      }),
    TypeError,
    "admission.authority.exchange",
  );
  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        admission: {
          ...valid.admission,
          repository: {
            assertCurrent: repository.assertCurrent,
          } as WorkerAdmissionRepository,
        },
      }),
    TypeError,
    "admission.repository",
  );
  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        admission: {
          ...valid.admission,
          repository: {
            getDefinition: repository.getDefinition,
          } as WorkerAdmissionRepository,
        },
      }),
    TypeError,
    "admission.repository",
  );
});
