import type { JsonObject, WorkerIdentity } from "../protocol/types.ts";
import {
  assertProviderOwnsResource,
  assertProviderResourceMatches,
  cloneProviderJsonObject,
  createProviderError,
  createProviderInspection,
  createProviderResource,
  createProviderTermination,
  throwIfProviderOperationAborted,
  validateProviderId,
  validateProviderResourceId,
} from "./contract.ts";
import type { ProviderResource, WorkerProvider } from "./types.ts";

export type ExternallyAttachedLaunchSpec = Readonly<{
  attachmentId: string;
  attributes?: JsonObject;
}>;

export type ExternallyAttachedProviderOptions = Readonly<{
  providerId?: string;
  now?: () => number;
  createResourceId?: (
    request: Readonly<{
      attachmentId: string;
      workerId: string;
      attemptId: string;
      epoch: number;
    }>,
  ) => string;
}>;

/**
 * Durable fields needed to restore one externally attached reservation after
 * the owning process restarts.
 *
 * This restores provider identity only. Connection and readiness state still
 * come exclusively from the authenticated worker session.
 */
export type ExternallyAttachedResourceInput = Readonly<{
  resourceId: string;
  identity: WorkerIdentity;
  attachmentId: string;
  createdAtMs: number;
  attributes?: JsonObject;
}>;

export type ExternallyAttachedProvider =
  & WorkerProvider<ExternallyAttachedLaunchSpec>
  & Readonly<{
    /**
     * Restores an active durable reservation into this provider instance.
     *
     * Repeating the exact restoration is idempotent. A conflicting fenced
     * reference is rejected, and restoring a reservation already terminated
     * in this instance never makes it present again.
     */
    rehydrateResource(
      input: ExternallyAttachedResourceInput,
    ): ProviderResource;
  }>;

type AttachmentEntry = {
  resource: ProviderResource;
  attachmentId: string;
  terminatedAtMs?: number;
};

function asPromise<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Creates a provider for computers whose compute lifecycle is managed outside
 * Oxian (for example, a user's laptop).
 *
 * Provisioning creates a logical reservation only. It does not claim that the
 * computer is online; authenticated session state is the sole source of that
 * truth.
 */
export function createExternallyAttachedProvider(
  options: ExternallyAttachedProviderOptions = {},
): ExternallyAttachedProvider {
  const providerId = validateProviderId(
    options.providerId ?? "externally-attached",
  );
  const now = options.now ?? Date.now;
  const createResourceId = options.createResourceId ??
    (() => crypto.randomUUID());
  const attachments = new Map<string, AttachmentEntry>();

  const createAttachmentResource = (
    input: ExternallyAttachedResourceInput,
  ): ProviderResource => {
    const resourceId = validateProviderResourceId(input.resourceId);
    const attachmentId = validateProviderResourceId(input.attachmentId);
    const attributes = cloneProviderJsonObject(
      input.attributes ?? {},
      "$.attributes",
    );
    if (
      Object.hasOwn(attributes, "attachmentId") &&
      attributes.attachmentId !== attachmentId
    ) {
      throw createProviderError({
        code: "invalid_resource",
        message:
          `Provider resource ${resourceId} has a conflicting attachment id`,
        providerId,
        resourceId,
      });
    }
    return createProviderResource({
      providerId,
      resourceId,
      identity: input.identity,
      createdAtMs: input.createdAtMs,
      attributes: {
        ...attributes,
        attachmentId,
      },
    });
  };

  return Object.freeze({
    providerId,

    provision(request, operationOptions) {
      return asPromise(() => {
        throwIfProviderOperationAborted(operationOptions?.signal);
        const attachmentId = validateProviderResourceId(
          request.launch.attachmentId,
        );

        const resourceId = validateProviderResourceId(createResourceId({
          attachmentId,
          workerId: request.identity.workerId,
          attemptId: request.identity.attemptId,
          epoch: request.identity.epoch,
        }));
        if (attachments.has(resourceId)) {
          throw createProviderError({
            code: "conflict",
            message: `Provider resource ${resourceId} already exists`,
            providerId,
            resourceId,
          });
        }

        const resource = createAttachmentResource({
          resourceId,
          identity: request.identity,
          createdAtMs: now(),
          attachmentId,
          attributes: request.launch.attributes,
        });

        throwIfProviderOperationAborted(operationOptions?.signal);
        attachments.set(resourceId, {
          resource,
          attachmentId,
        });
        return resource;
      });
    },

    inspect(resourceInput, operationOptions) {
      return asPromise(() => {
        throwIfProviderOperationAborted(operationOptions?.signal);
        const resource = assertProviderOwnsResource(
          providerId,
          resourceInput,
        );
        const entry = attachments.get(resource.resourceId);

        if (!entry) {
          return createProviderInspection({
            resource,
            state: "unknown",
            observedAtMs: now(),
          });
        }
        assertProviderResourceMatches(
          providerId,
          resource,
          entry.resource,
        );

        if (entry.terminatedAtMs !== undefined) {
          return createProviderInspection({
            resource: entry.resource,
            state: "absent",
            observedAtMs: now(),
            details: {
              attachmentId: entry.attachmentId,
              terminatedAtMs: entry.terminatedAtMs,
            },
          });
        }

        return createProviderInspection({
          resource: entry.resource,
          state: "present",
          observedAtMs: now(),
          details: {
            attachmentId: entry.attachmentId,
          },
        });
      });
    },

    terminate(resourceInput, operationOptions) {
      return asPromise(() => {
        throwIfProviderOperationAborted(operationOptions?.signal);
        const resource = assertProviderOwnsResource(
          providerId,
          resourceInput,
        );
        const entry = attachments.get(resource.resourceId);

        if (!entry) {
          return createProviderTermination({
            resource,
            outcome: "unknown",
            observedAtMs: now(),
          });
        }
        assertProviderResourceMatches(
          providerId,
          resource,
          entry.resource,
        );

        if (entry.terminatedAtMs !== undefined) {
          return createProviderTermination({
            resource: entry.resource,
            outcome: "already_absent",
            observedAtMs: now(),
            details: {
              attachmentId: entry.attachmentId,
              terminatedAtMs: entry.terminatedAtMs,
            },
          });
        }

        throwIfProviderOperationAborted(operationOptions?.signal);
        entry.terminatedAtMs = now();
        return createProviderTermination({
          resource: entry.resource,
          outcome: "terminated",
          observedAtMs: entry.terminatedAtMs,
          details: {
            attachmentId: entry.attachmentId,
            terminatedAtMs: entry.terminatedAtMs,
          },
        });
      });
    },

    rehydrateResource(input) {
      const resource = createAttachmentResource(input);
      const existing = attachments.get(resource.resourceId);
      if (existing !== undefined) {
        assertProviderResourceMatches(
          providerId,
          resource,
          existing.resource,
        );
        return existing.resource;
      }

      attachments.set(resource.resourceId, {
        resource,
        attachmentId: input.attachmentId,
      });
      return resource;
    },
  });
}
