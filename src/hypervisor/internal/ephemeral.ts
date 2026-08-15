import type {
  HypervisorAdmit,
  WorkerActivate,
  WorkerRegister,
} from "../../lifecycle/index.ts";
import { createEphemeralCredentialLifecycle } from "../../supervisor/credentials.ts";
import { createEphemeralWorkerStore } from "../../supervisor/store.ts";
import type { WorkerDefinition } from "../../supervisor/types.ts";

export type EphemeralWorkerLifecycle = Readonly<{
  activate: WorkerActivate;
  register: WorkerRegister;
  admit: HypervisorAdmit;
}>;

/**
 * Process-lifetime lifecycle used only when a local transport owner does not
 * inject durable activation, registration, and admission functions.
 */
export function createEphemeralWorkerLifecycle(): EphemeralWorkerLifecycle {
  const repository = createEphemeralWorkerStore();
  const authority = createEphemeralCredentialLifecycle();
  const definitions = new Map<string, WorkerDefinition>();

  const activate: WorkerActivate = async (context) => {
    const existing = definitions.get(context.workerId);
    if (existing === undefined) {
      const definition = await repository.define({
        workerId: context.workerId,
        providerId: "in-process",
        workloads: context.workloads,
        capacity: context.capacity,
        providerConfig: {},
        labels: {},
      });
      definitions.set(context.workerId, definition);
    } else if (
      existing.capacity !== context.capacity ||
      existing.workloads.length !== context.workloads.length ||
      existing.workloads.some((name, index) =>
        name !== context.workloads[index]
      )
    ) {
      throw new TypeError(
        `in-process Worker ${
          JSON.stringify(context.workerId)
        } was activated with a different declaration`,
      );
    }
    const activation = await repository.activate(context.workerId);
    return Object.freeze({ identity: activation.attempt.identity });
  };

  const register: WorkerRegister = async (context) => {
    const grant = await authority.issueRegistration(context.identity);
    return Object.freeze({
      credential: grant.credential,
      expiresAtMs: grant.expiresAtMs,
    });
  };

  const admit: HypervisorAdmit = async (context) => {
    await repository.assertCurrent(context.identity);
    const definition = await repository.getDefinition(
      context.identity.workerId,
    );
    if (definition === undefined) {
      throw Object.assign(new Error("Worker definition is missing"), {
        code: "stale_attempt",
      });
    }
    const exchange = await authority.exchange({
      identity: context.identity,
      credential: context.credential,
      handshakeId: context.handshakeId,
    });
    return Object.freeze({
      definition,
      sessionGeneration: exchange.sessionGeneration,
      authenticatedWith: exchange.authenticatedWith,
      resume: Object.freeze({
        credential: exchange.resume.credential,
        expiresAtMs: exchange.resume.expiresAtMs,
      }),
      bootstrap: Object.freeze({}),
    });
  };

  return Object.freeze({ activate, register, admit });
}
