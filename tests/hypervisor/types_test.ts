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
    authority: admissionAuthority,
    repository: admissionRepository,
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
    authority: { exchange: authority.exchange },
    repository: {
      getDefinition: repository.getDefinition,
      assertCurrent: repository.assertCurrent,
    },
    persistAcceptance: () => Promise.resolve(),
  };

  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        authority: {} as WorkerAdmissionAuthority,
      }),
    TypeError,
    "authority.exchange",
  );
  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        repository: {
          assertCurrent: repository.assertCurrent,
        } as WorkerAdmissionRepository,
      }),
    TypeError,
    "repository.getDefinition",
  );
  assertThrows(
    () =>
      createHypervisor({
        ...valid,
        repository: {
          getDefinition: repository.getDefinition,
        } as WorkerAdmissionRepository,
      }),
    TypeError,
    "repository.assertCurrent",
  );
});
