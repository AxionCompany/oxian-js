import { createWorkerIdentity } from "../protocol/control.ts";
import type { WorkerIdentity } from "../protocol/types.ts";
import type {
  ProviderInspection,
  ProviderProvisionRequest,
  ProviderResource,
  ProviderTermination,
  WorkerProvider,
} from "./types.ts";

const DEFAULT_IDENTITY: WorkerIdentity = {
  workerId: "provider-conformance-worker",
  attemptId: "provider-conformance-attempt",
  epoch: 1,
};

export type ProviderConformanceCheck =
  | "pre-aborted provision"
  | "provision"
  | "resource identity"
  | "session-independent resource"
  | "inspect present"
  | "pre-aborted inspect"
  | "pre-aborted terminate"
  | "terminate"
  | "inspect absent"
  | "idempotent terminate";

export type ProviderConformanceReport = Readonly<{
  checks: readonly ProviderConformanceCheck[];
  resource: ProviderResource;
  initialInspection: ProviderInspection;
  termination: ProviderTermination;
  finalInspection: ProviderInspection;
  repeatedTermination: ProviderTermination;
}>;

export type ProviderConformanceOptions<TLaunchSpec> = Readonly<{
  provider: WorkerProvider<TLaunchSpec>;
  launch: TLaunchSpec;
  identity?: WorkerIdentity;
}>;

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`WorkerProvider conformance failed: ${message}`);
  }
}

async function ensureAbort(
  operation: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    ensure(
      error instanceof DOMException && error.name === "AbortError",
      `${label} must reject with AbortError`,
    );
    return;
  }
  throw new Error(
    `WorkerProvider conformance failed: ${label} must reject when pre-aborted`,
  );
}

function assertNoSessionState(resource: ProviderResource): void {
  const value = resource as unknown as Record<string, unknown>;
  for (
    const forbidden of [
      "connectionId",
      "ready",
      "session",
      "socket",
      "target",
      "url",
    ]
  ) {
    ensure(
      !Object.hasOwn(value, forbidden),
      `provider resources must not expose ${forbidden}`,
    );
  }
}

/**
 * Runs provider-neutral lifecycle checks without coupling the library to a test
 * runner. Provider implementations and downstream adapters can invoke the same
 * deterministic harness from their own suites.
 */
export async function runProviderConformance<TLaunchSpec>(
  options: ProviderConformanceOptions<TLaunchSpec>,
): Promise<ProviderConformanceReport> {
  const checks: ProviderConformanceCheck[] = [];
  const identity = createWorkerIdentity(
    options.identity ?? DEFAULT_IDENTITY,
  );
  const request: ProviderProvisionRequest<TLaunchSpec> = {
    identity,
    launch: options.launch,
  };

  const provisionAbort = new AbortController();
  provisionAbort.abort();
  await ensureAbort(
    () =>
      options.provider.provision(request, {
        signal: provisionAbort.signal,
      }),
    "pre-aborted provision",
  );
  checks.push("pre-aborted provision");

  const resource = await options.provider.provision(request);
  checks.push("provision");
  ensure(
    resource.providerId === options.provider.providerId,
    "provisioned resource must name its provider",
  );
  ensure(
    resource.identity.workerId === identity.workerId &&
      resource.identity.attemptId === identity.attemptId &&
      resource.identity.epoch === identity.epoch,
    "provisioned resource must preserve the fenced worker identity",
  );
  checks.push("resource identity");
  assertNoSessionState(resource);
  checks.push("session-independent resource");

  let terminated = false;
  try {
    const initialInspection = await options.provider.inspect(resource);
    ensure(
      initialInspection.state === "present",
      "a newly provisioned resource must be present",
    );
    checks.push("inspect present");

    const inspectAbort = new AbortController();
    inspectAbort.abort();
    await ensureAbort(
      () =>
        options.provider.inspect(resource, {
          signal: inspectAbort.signal,
        }),
      "pre-aborted inspect",
    );
    checks.push("pre-aborted inspect");

    const terminateAbort = new AbortController();
    terminateAbort.abort();
    await ensureAbort(
      () =>
        options.provider.terminate(resource, {
          signal: terminateAbort.signal,
        }),
      "pre-aborted terminate",
    );
    checks.push("pre-aborted terminate");
    ensure(
      (await options.provider.inspect(resource)).state === "present",
      "pre-aborted termination must not mutate the resource",
    );

    const termination = await options.provider.terminate(resource);
    terminated = true;
    ensure(
      termination.outcome === "terminated",
      "first termination must report terminated",
    );
    checks.push("terminate");

    const finalInspection = await options.provider.inspect(resource);
    ensure(
      finalInspection.state === "absent",
      "terminated resource must be absent",
    );
    checks.push("inspect absent");

    const repeatedTermination = await options.provider.terminate(resource);
    ensure(
      repeatedTermination.outcome === "already_absent",
      "repeated termination must be idempotent",
    );
    checks.push("idempotent terminate");

    return Object.freeze({
      checks: Object.freeze([...checks]),
      resource,
      initialInspection,
      termination,
      finalInspection,
      repeatedTermination,
    });
  } finally {
    if (!terminated) {
      await options.provider.terminate(resource).catch(() => {});
    }
  }
}
