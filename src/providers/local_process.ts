import type { JsonObject } from "../protocol/types.ts";
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
import type {
  ProviderResource,
  ProviderTermination,
  WorkerProvider,
} from "./types.ts";

export type LocalProcessStdio = "inherit" | "null";

export type LocalProcessLaunchSpec = Readonly<{
  command: string | URL;
  args?: readonly string[];
  cwd?: string | URL;
  env?: Readonly<Record<string, string>>;
  /** Defaults to true so parent-process credentials are never inherited. */
  clearEnv?: boolean;
  stdin?: LocalProcessStdio;
  stdout?: LocalProcessStdio;
  stderr?: LocalProcessStdio;
  attributes?: JsonObject;
}>;

export type LocalProcessHandle = Readonly<{
  pid: number;
  status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}>;

export type LocalProcessSpawner = (
  command: string | URL,
  options: Deno.CommandOptions,
) => LocalProcessHandle;

export type LocalProcessProviderOptions = Readonly<{
  providerId?: string;
  now?: () => number;
  createResourceId?: (
    request: Readonly<{
      workerId: string;
      attemptId: string;
      epoch: number;
    }>,
  ) => string;
  defaultGracePeriodMs?: number;
  forceExitTimeoutMs?: number;
  gracefulSignal?: Deno.Signal;
  forceSignal?: Deno.Signal;
  spawnProcess?: LocalProcessSpawner;
}>;

type ProcessEntry = {
  resource: ProviderResource;
  child: LocalProcessHandle;
  statusPromise: Promise<Deno.CommandStatus>;
  status?: Deno.CommandStatus;
  statusError?: unknown;
  statusRejected: boolean;
  terminationRequested: boolean;
  terminationPromise?: Promise<ProviderTermination>;
};

type NormalizedLaunchSpec = {
  command: string | URL;
  options: Deno.CommandOptions;
  commandLabel: string;
  attributes: JsonObject;
};

const DEFAULT_GRACE_PERIOD_MS = 5_000;
const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 5_000;

function validateDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeLaunchSpec(
  providerId: string,
  spec: LocalProcessLaunchSpec,
): NormalizedLaunchSpec {
  if (spec === null || typeof spec !== "object") {
    throw createProviderError({
      code: "invalid_launch_spec",
      message: "Local process launch spec must be an object",
      providerId,
    });
  }
  if (
    !(typeof spec.command === "string" && spec.command.length > 0) &&
    !(spec.command instanceof URL)
  ) {
    throw createProviderError({
      code: "invalid_launch_spec",
      message: "Local process command must be a non-empty string or URL",
      providerId,
    });
  }

  if (
    typeof spec.command === "string" &&
    spec.command.includes("\0")
  ) {
    throw createProviderError({
      code: "invalid_launch_spec",
      message: "Local process command must not contain a null character",
      providerId,
    });
  }

  const args = [...(spec.args ?? [])];
  if (
    args.some((value) => typeof value !== "string" || value.includes("\0"))
  ) {
    throw createProviderError({
      code: "invalid_launch_spec",
      message:
        "Local process arguments must be strings without null characters",
      providerId,
    });
  }

  if (
    spec.cwd !== undefined &&
    !(typeof spec.cwd === "string" && spec.cwd.length > 0) &&
    !(spec.cwd instanceof URL)
  ) {
    throw createProviderError({
      code: "invalid_launch_spec",
      message: "Local process cwd must be a non-empty string or URL",
      providerId,
    });
  }
  if (
    spec.clearEnv !== undefined &&
    typeof spec.clearEnv !== "boolean"
  ) {
    throw createProviderError({
      code: "invalid_launch_spec",
      message: "Local process clearEnv must be a boolean",
      providerId,
    });
  }
  for (
    const [field, value] of [
      ["stdin", spec.stdin],
      ["stdout", spec.stdout],
      ["stderr", spec.stderr],
    ] as const
  ) {
    if (
      value !== undefined &&
      value !== "inherit" &&
      value !== "null"
    ) {
      throw createProviderError({
        code: "invalid_launch_spec",
        message: `Local process ${field} must be inherit or null`,
        providerId,
      });
    }
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0") ||
      typeof value !== "string" ||
      value.includes("\0")
    ) {
      throw createProviderError({
        code: "invalid_launch_spec",
        message: `Invalid local process environment entry ${
          JSON.stringify(key)
        }`,
        providerId,
      });
    }
    env[key] = value;
  }

  const commandLabel = spec.command instanceof URL
    ? spec.command.toString()
    : spec.command;
  return {
    command: spec.command,
    commandLabel,
    options: {
      args,
      cwd: spec.cwd,
      env,
      clearEnv: spec.clearEnv ?? true,
      stdin: spec.stdin ?? "null",
      stdout: spec.stdout ?? "inherit",
      stderr: spec.stderr ?? "inherit",
    },
    attributes: cloneProviderJsonObject(
      spec.attributes ?? {},
      "$.launch.attributes",
    ),
  };
}

function statusDetails(
  entry: ProcessEntry,
  status: Deno.CommandStatus,
): JsonObject {
  return {
    exitCode: status.code,
    pid: entry.child.pid,
    signal: status.signal ?? null,
    success: status.success,
  };
}

function delay(ms: number): {
  promise: Promise<"timeout">;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function settleWithin(
  statusPromise: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<Deno.CommandStatus | undefined> {
  if (timeoutMs === 0) return undefined;
  const timeout = delay(timeoutMs);
  try {
    const result = await Promise.race([
      statusPromise,
      timeout.promise,
    ]);
    return result === "timeout" ? undefined : result;
  } finally {
    timeout.cancel();
  }
}

function waitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function asPromise<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Creates a provider backed by real local child processes.
 *
 * Children are launched directly through `Deno.Command`; no shell parses the
 * executable or argument list. The provider observes process existence but
 * never infers worker-session readiness from it.
 */
export function createLocalProcessProvider(
  options: LocalProcessProviderOptions = {},
): WorkerProvider<LocalProcessLaunchSpec> {
  const providerId = validateProviderId(
    options.providerId ?? "local-process",
  );
  const now = options.now ?? Date.now;
  const createResourceId = options.createResourceId ??
    (() => crypto.randomUUID());
  const defaultGracePeriodMs = validateDuration(
    options.defaultGracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
    "defaultGracePeriodMs",
  );
  const forceExitTimeoutMs = validateDuration(
    options.forceExitTimeoutMs ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS,
    "forceExitTimeoutMs",
  );
  const gracefulSignal = options.gracefulSignal ?? "SIGTERM";
  const forceSignal = options.forceSignal ?? "SIGKILL";
  const spawnProcess = options.spawnProcess ??
    ((command: string | URL, commandOptions: Deno.CommandOptions) =>
      new Deno.Command(command, commandOptions).spawn());
  const processes = new Map<string, ProcessEntry>();

  return Object.freeze({
    providerId,

    async provision(request, operationOptions) {
      throwIfProviderOperationAborted(operationOptions?.signal);
      const launch = normalizeLaunchSpec(providerId, request.launch);
      const resourceId = validateProviderResourceId(createResourceId({
        workerId: request.identity.workerId,
        attemptId: request.identity.attemptId,
        epoch: request.identity.epoch,
      }));
      if (processes.has(resourceId)) {
        throw createProviderError({
          code: "conflict",
          message: `Provider resource ${resourceId} already exists`,
          providerId,
          resourceId,
        });
      }

      // Validate and freeze every durable field before creating a process. Once
      // spawn succeeds, no later validation error can orphan that child.
      const resource = createProviderResource({
        providerId,
        resourceId,
        identity: request.identity,
        createdAtMs: now(),
        attributes: {
          ...launch.attributes,
          command: launch.commandLabel,
        },
      });

      let child: LocalProcessHandle;
      try {
        child = spawnProcess(launch.command, launch.options);
      } catch (cause) {
        throw createProviderError({
          code: "provision_failed",
          message: `Failed to launch local process ${launch.commandLabel}`,
          providerId,
          resourceId,
          cause,
        });
      }

      let statusPromise: Promise<Deno.CommandStatus>;
      try {
        statusPromise = Promise.resolve(child.status);
      } catch (cause) {
        try {
          child.kill(forceSignal);
        } catch {
          // The injected or platform child may already be gone.
        }
        throw createProviderError({
          code: "provision_failed",
          message:
            `Failed to observe newly launched local process ${launch.commandLabel}`,
          providerId,
          resourceId,
          cause,
        });
      }
      const entry: ProcessEntry = {
        resource,
        child,
        statusPromise,
        statusRejected: false,
        terminationRequested: false,
      };
      entry.statusPromise.then(
        (status) => {
          entry.status = status;
        },
        (error) => {
          entry.statusError = error;
          entry.statusRejected = true;
        },
      );
      processes.set(resourceId, entry);

      if (operationOptions?.signal?.aborted) {
        entry.terminationRequested = true;
        try {
          child.kill(forceSignal);
        } catch {
          // The process may have exited between spawn and cancellation.
        }
        try {
          entry.status = await settleWithin(
            entry.statusPromise,
            forceExitTimeoutMs,
          );
        } catch (error) {
          entry.statusError = error;
          entry.statusRejected = true;
          // Preserve the caller's abort reason.
        }
        operationOptions.signal.throwIfAborted();
      }

      return resource;
    },

    inspect(resourceInput, operationOptions) {
      return asPromise(() => {
        throwIfProviderOperationAborted(operationOptions?.signal);
        const resource = assertProviderOwnsResource(
          providerId,
          resourceInput,
        );
        const entry = processes.get(resource.resourceId);
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

        if (entry.statusRejected) {
          return createProviderInspection({
            resource: entry.resource,
            state: "unknown",
            observedAtMs: now(),
            details: {
              pid: entry.child.pid,
            },
          });
        }
        if (!entry.status) {
          return createProviderInspection({
            resource: entry.resource,
            state: "present",
            observedAtMs: now(),
            details: {
              pid: entry.child.pid,
            },
          });
        }

        const state = entry.terminationRequested || entry.status.success
          ? "absent"
          : "failed";
        return createProviderInspection({
          resource: entry.resource,
          state,
          observedAtMs: now(),
          details: statusDetails(entry, entry.status),
        });
      });
    },

    async terminate(resourceInput, operationOptions) {
      throwIfProviderOperationAborted(operationOptions?.signal);
      const resource = assertProviderOwnsResource(
        providerId,
        resourceInput,
      );
      const entry = processes.get(resource.resourceId);
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

      if (entry.statusRejected) {
        try {
          entry.child.kill(forceSignal);
        } catch {
          // Status is already unknowable; preserve its original failure cause.
        }
        throw createProviderError({
          code: "termination_failed",
          message: `Local process ${entry.child.pid} status observation failed`,
          providerId,
          resourceId: entry.resource.resourceId,
          cause: entry.statusError,
        });
      }
      if (entry.status) {
        return createProviderTermination({
          resource: entry.resource,
          outcome: "already_absent",
          observedAtMs: now(),
          details: statusDetails(entry, entry.status),
        });
      }

      if (!entry.terminationPromise) {
        const gracePeriodMs = validateDuration(
          operationOptions?.gracePeriodMs ?? defaultGracePeriodMs,
          "gracePeriodMs",
        );
        entry.terminationRequested = true;
        entry.terminationPromise = (async () => {
          const observeStatus = async (
            timeoutMs: number,
            phase: string,
          ): Promise<Deno.CommandStatus | undefined> => {
            try {
              return await settleWithin(
                entry.statusPromise,
                timeoutMs,
              );
            } catch (cause) {
              entry.statusError = cause;
              entry.statusRejected = true;
              throw createProviderError({
                code: "termination_failed",
                message:
                  `Local process ${entry.child.pid} status observation failed ${phase}`,
                providerId,
                resourceId: entry.resource.resourceId,
                cause,
              });
            }
          };

          try {
            entry.child.kill(gracefulSignal);
          } catch {
            // It may have exited after the status check above.
          }

          let status = await observeStatus(
            gracePeriodMs,
            "during graceful termination",
          );
          if (!status) {
            let forceKillError: unknown;
            try {
              entry.child.kill(forceSignal);
            } catch (error) {
              forceKillError = error;
            }
            status = await observeStatus(
              forceExitTimeoutMs,
              "after forced termination",
            );
            if (!status) {
              throw createProviderError({
                code: "termination_failed",
                message:
                  `Local process ${entry.child.pid} did not exit within ${forceExitTimeoutMs}ms after ${forceSignal}`,
                providerId,
                resourceId: entry.resource.resourceId,
                cause: forceKillError,
              });
            }
          }

          entry.status = status;
          return createProviderTermination({
            resource: entry.resource,
            outcome: "terminated",
            observedAtMs: now(),
            details: statusDetails(entry, status),
          });
        })();
      }

      // Aborting a wait does not abandon the child: termination continues in
      // the provider closure so a cancelled caller cannot leak a process.
      return await waitWithAbort(
        entry.terminationPromise,
        operationOptions?.signal,
      );
    },
  });
}
