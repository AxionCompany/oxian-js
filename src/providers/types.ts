import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";

/**
 * A provider resource is the compute (or externally managed reservation)
 * associated with one fenced worker attempt.
 *
 * It intentionally contains no connection, readiness, transport, or workload
 * state. Those belong to the supervisor and the authenticated worker session.
 */
export type ProviderResource = Readonly<{
  providerId: string;
  resourceId: string;
  identity: WorkerIdentity;
  createdAtMs: number;
  attributes: JsonObject;
}>;

export type ProviderResourceState =
  | "present"
  | "absent"
  | "failed"
  | "unknown";

/**
 * `present` only means that the provider can still observe the resource. It
 * never means that a worker session is connected or ready to receive work.
 */
export type ProviderInspection = Readonly<{
  resource: ProviderResource;
  state: ProviderResourceState;
  observedAtMs: number;
  details: JsonObject;
}>;

export type ProviderTerminationOutcome =
  | "terminated"
  | "already_absent"
  | "unknown";

export type ProviderTermination = Readonly<{
  resource: ProviderResource;
  outcome: ProviderTerminationOutcome;
  observedAtMs: number;
  details: JsonObject;
}>;

export type ProviderProvisionRequest<TLaunchSpec> = Readonly<{
  identity: WorkerIdentity;
  launch: TLaunchSpec;
}>;

export type ProviderOperationOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type ProviderTerminateOptions = Readonly<{
  signal?: AbortSignal;
  /**
   * Best-effort graceful-shutdown window for providers that expose a graceful
   * signal before forced termination. Providers whose API only supports an
   * immediate terminal request may validate and ignore this hint.
   */
  gracePeriodMs?: number;
}>;

/**
 * Compute lifecycle boundary used by the supervisor.
 *
 * Providers do exactly three things: create compute, observe whether that
 * compute still exists, and terminate it. Session readiness is deliberately
 * absent from this contract.
 */
export type WorkerProvider<TLaunchSpec> = Readonly<{
  providerId: string;
  provision(
    request: ProviderProvisionRequest<TLaunchSpec>,
    options?: ProviderOperationOptions,
  ): Promise<ProviderResource>;
  inspect(
    resource: ProviderResource,
    options?: ProviderOperationOptions,
  ): Promise<ProviderInspection>;
  terminate(
    resource: ProviderResource,
    options?: ProviderTerminateOptions,
  ): Promise<ProviderTermination>;
}>;

export type ProviderErrorCode =
  | "aborted"
  | "conflict"
  | "invalid_launch_spec"
  | "invalid_resource"
  | "inspection_failed"
  | "provision_failed"
  | "provision_indeterminate"
  | "termination_failed";

export type ProviderError =
  & Error
  & Readonly<{
    name: "ProviderError";
    code: ProviderErrorCode;
    providerId: string;
    resourceId?: string;
  }>;
