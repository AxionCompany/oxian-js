import { WORKER_PROTOCOL } from "../protocol/index.ts";
import {
  createSessionRegistry,
  createWorkDispatcher,
  type WorkDispatcher,
} from "../supervisor/index.ts";
import type { HypervisorLifecycleCallbacks } from "../lifecycle/index.ts";
import {
  bindInProcessFabric,
  type InProcessTransportBinding,
} from "../transport/in-process.ts";
import { createHypervisorConfig } from "./config.ts";
import { createAdmissionController } from "./internal/admission.ts";
import { createConnectionAdmission } from "./internal/connection.ts";
import { createConnectionDirectory } from "./internal/directory.ts";
import { createDispatch } from "./internal/dispatch.ts";
import { createDrainController } from "./internal/drain.ts";
import { createEphemeralWorkerLifecycle } from "./internal/ephemeral.ts";
import { createConnectionLifecycleController } from "./internal/lifecycle.ts";
import { createSessionProtocolController } from "./internal/session.ts";
import {
  createWorkStreamController,
  type WorkStreamController,
} from "./internal/work-stream.ts";
import type { AcceptanceAdmissionState } from "./internal/model.ts";
import {
  createDefaultScheduler,
  createHypervisorError,
  NORMAL_CLOSE_CODE,
} from "./internal/primitives.ts";
import type { Hypervisor, HypervisorOptions } from "./types.ts";

function expectWebSocketPath(value: unknown): string {
  let canonical = false;
  if (typeof value === "string") {
    try {
      const base = new URL("https://oxian.invalid/");
      const parsed = new URL(value, base);
      canonical = parsed.origin === base.origin && parsed.pathname === value &&
        parsed.search === "" && parsed.hash === "";
    } catch {
      canonical = false;
    }
  }
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value[0] !== "/" ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    !canonical
  ) {
    throw new TypeError(
      "WebSocket transport config.path must be an absolute canonical path without a trailing slash, query, fragment, authority, dot segments, or backslash",
    );
  }
  return value;
}

/**
 * Creates the transport-neutral Oxian Hypervisor.
 *
 * The returned capability owns declared transport bindings but no network
 * listener. Every Worker becomes routable only after admission, the v1
 * handshake, readiness, and fenced session attachment.
 */
export function createHypervisor(
  options: HypervisorOptions,
  callbacks: HypervisorLifecycleCallbacks = {},
): Hypervisor {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createHypervisor options are required");
  }
  if (callbacks === null || typeof callbacks !== "object") {
    throw new TypeError("Hypervisor lifecycle callbacks must be an object");
  }
  for (
    const name of [
      "onConnect",
      "onAdmit",
      "onHandshake",
      "onReady",
      "onHeartbeat",
      "onWorkAssigned",
      "onWorkAccepted",
      "onStart",
      "onComplete",
      "onDisconnect",
    ] as const
  ) {
    if (
      callbacks[name] !== undefined && typeof callbacks[name] !== "function"
    ) {
      throw new TypeError(`${name} must be a function`);
    }
  }
  if (!Array.isArray(options.transports) || options.transports.length === 0) {
    throw new TypeError(
      "Hypervisor transports must contain at least one declaration",
    );
  }
  const localTopics = new Set<string>();
  const websocketPaths = new Set<string>();
  for (const transport of options.transports) {
    if (transport?.type === "in-process") {
      if (
        typeof transport.config?.topic !== "string" ||
        transport.config.topic.length === 0
      ) {
        throw new TypeError("in-process transport config.topic is required");
      }
      if (localTopics.has(transport.config.topic)) {
        throw new TypeError(
          "Hypervisor in-process transport topics must be unique",
        );
      }
      localTopics.add(transport.config.topic);
    } else if (transport?.type === "websocket") {
      const path = expectWebSocketPath(transport.config?.path);
      if (websocketPaths.has(path)) {
        throw new TypeError(
          "Hypervisor WebSocket transport paths must be unique",
        );
      }
      websocketPaths.add(path);
    } else {
      throw new TypeError(
        'Hypervisor transport.type must be "in-process" or "websocket"',
      );
    }
  }
  if (options.admit !== undefined && typeof options.admit !== "function") {
    throw new TypeError("admit must be a function");
  }
  if (options.assign !== undefined && typeof options.assign !== "function") {
    throw new TypeError("assign must be a function");
  }
  if (
    websocketPaths.size > 0 && options.admit === undefined &&
    localTopics.size === 0
  ) {
    throw new TypeError("WebSocket Hypervisors require an admit function");
  }
  const config = createHypervisorConfig(options.config);
  const clock = options.clock ?? Date.now;
  const scheduler = options.scheduler ?? createDefaultScheduler();
  const createConnectionId = options.createConnectionId ??
    (() => crypto.randomUUID());
  const sessions = options.sessions ?? createSessionRegistry({ clock });
  const ephemeral = localTopics.size > 0
    ? createEphemeralWorkerLifecycle()
    : undefined;
  const effectiveAdmit = options.admit === undefined
    ? ephemeral?.admit
    : ephemeral === undefined
    ? options.admit
    : async (
      context: Parameters<NonNullable<HypervisorOptions["admit"]>>[0],
    ) => {
      try {
        return await options.admit!(context);
      } catch (primaryError) {
        try {
          return await ephemeral.admit(context);
        } catch {
          throw primaryError;
        }
      }
    };
  const effectiveOptions: HypervisorOptions = Object.freeze({
    ...options,
    ...(effectiveAdmit === undefined ? {} : { admit: effectiveAdmit }),
  });
  const hostAbort = new AbortController();
  const dispatcher: WorkDispatcher = createWorkDispatcher({
    sessions,
    commitAcceptedWork: async (commit) => {
      await callbacks.onWorkAccepted?.(Object.freeze({
        stage: "work_accepted" as const,
        stageId:
          `work_accepted:${commit.operationId}:${commit.assignment.streamId}`,
        callbackAttempt: 1,
        // The acceptance decision must settle even when its physical
        // connection disappears. Only the Hypervisor lifecycle owns this
        // signal; connection cleanup deliberately does not abort it.
        signal: hostAbort.signal,
        identity: commit.assignment.fence.identity,
        connectionId: commit.assignment.fence.connectionId,
        operationId: commit.operationId,
        streamId: commit.assignment.streamId,
        workload: commit.workload,
        metadata: commit.metadata,
        fence: commit.assignment.fence,
      }));
    },
    clock,
  });
  const directory = createConnectionDirectory(createConnectionId);
  const records = directory.records;
  const admission = createAdmissionController(config);
  let acceptingConnections = true;
  let shuttingDown: Promise<void> | undefined;
  const acceptanceAdmission: AcceptanceAdmissionState = {
    pending: 0,
    byWorker: new Map(),
  };
  const workStreamBinding: { current?: WorkStreamController } = {};
  const finishPending: WorkStreamController["finishPending"] = (...args) =>
    workStreamBinding.current!.finishPending(...args);
  const lifecycle = createConnectionLifecycleController({
    config,
    clock,
    scheduler,
    sessions,
    dispatcher,
    directory,
    admission,
    callbacks,
    finishPending,
  });
  const cleanupConnection = lifecycle.cleanup;
  const closeRecord = lifecycle.close;
  const rejectRecord = lifecycle.reject;
  const armLeaseSweep = lifecycle.armLeaseSweep;

  const drainController = createDrainController({
    config,
    clock,
    scheduler,
    sessions,
    closeRecord,
  });
  const finishDrain = drainController.finish;
  const drainRecord = drainController.drain;

  const workStreams = createWorkStreamController({
    config,
    clock,
    scheduler,
    sessions,
    dispatcher,
    callbacks,
    acceptanceAdmission,
    closeRecord,
    drainRecord,
  });
  workStreamBinding.current = workStreams;
  const handleWorkControl = workStreams.handleControl;
  const handleWorkData = workStreams.handleData;
  const openPending = workStreams.open;

  const sessionProtocol = createSessionProtocolController({
    hypervisor: effectiveOptions,
    callbacks,
    config,
    clock,
    scheduler,
    sessions,
    directory,
    admission,
    closeRecord,
    drainRecord,
    finishDrain,
    handleWorkControl,
    rejectRecord,
  });
  const welcome = sessionProtocol.welcome;
  const ready = sessionProtocol.ready;
  const handleReadyFrame = sessionProtocol.handleFrame;

  const prepareRegistered = createConnectionAdmission({
    config,
    clock,
    scheduler,
    sessions,
    directory,
    admission,
    isAcceptingConnections: () => acceptingConnections,
    fallback: options.fallback,
    armLeaseSweep,
    welcome,
    ready,
    handleReadyFrame,
    handleWorkData,
    closeRecord,
    rejectRecord,
    cleanupConnection,
  });
  const transportBindings: InProcessTransportBinding[] = [];
  try {
    for (const transport of options.transports) {
      if (transport.type !== "in-process") continue;
      transportBindings.push(bindInProcessFabric({
        topic: transport.config.topic,
        accept(connection) {
          prepareRegistered.accept(
            connection,
            WORKER_PROTOCOL,
            "in-process",
          );
        },
        ...(ephemeral === undefined ? {} : {
          provisioning: Object.freeze({
            activate: ephemeral.activate,
            register: ephemeral.register,
          }),
        }),
      }));
    }
  } catch (error) {
    for (const binding of transportBindings) {
      binding.close("in_process_binding_rollback");
    }
    throw error;
  }

  const dispatch = createDispatch({
    dispatcher,
    sessions,
    assign: options.assign,
    onWorkAssigned: callbacks.onWorkAssigned,
    clock,
    signal: hostAbort.signal,
    open(offered, input) {
      const assignment = offered.assignment!;
      const record = directory.get(assignment.fence.connectionId);
      if (record === undefined) {
        throw createHypervisorError(
          "worker_unavailable",
          "assigned Worker connection is unavailable",
          {
            identity: assignment.fence.identity,
            operationId: offered.operationId,
          },
        );
      }
      return openPending(
        record,
        offered.operationId,
        Object.freeze({
          streamId: assignment.streamId,
          workload: offered.workload,
          metadata: offered.metadata,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.deadlineAtMs === undefined
            ? {}
            : { deadlineAtMs: input.deadlineAtMs }),
        }),
        input.signal,
      );
    },
  });

  const prepare: Hypervisor["prepare"] = (request) => {
    const path = new URL(request.url).pathname;
    if (!websocketPaths.has(path)) {
      return Object.freeze({
        kind: "response" as const,
        response: options.fallback?.(request) ??
          new Response("Not Found", { status: 404 }),
      });
    }
    if (options.admit === undefined) {
      return Object.freeze({
        kind: "response" as const,
        response: new Response("Remote worker admission is not configured", {
          status: 404,
        }),
      });
    }
    return prepareRegistered.prepare(request);
  };

  const drain = async (
    workerId: string,
    reason = "requested",
  ): Promise<void> => {
    const session = sessions.get(workerId);
    if (session === undefined) return;
    const record = directory.get(session.connectionId);
    if (record !== undefined) {
      await drainRecord(record, reason, "rotate");
    }
  };

  const shutdownWorker = async (
    workerId: string,
    reason = "worker_shutdown",
  ): Promise<void> => {
    const session = sessions.get(workerId);
    if (session === undefined) return;
    const record = directory.get(session.connectionId);
    if (record !== undefined) {
      await drainRecord(record, reason, "shutdown");
    }
  };

  const shutdownSession = async (
    fence: Parameters<Hypervisor["shutdownSession"]>[0],
    reason = "session_shutdown",
  ): Promise<void> => {
    if (!sessions.isCurrent(fence)) return;
    const record = directory.get(fence.connectionId);
    if (
      record?.fence?.identity.workerId !== fence.identity.workerId ||
      record.fence.identity.attemptId !== fence.identity.attemptId ||
      record.fence.identity.epoch !== fence.identity.epoch ||
      record.fence.sessionGeneration !== fence.sessionGeneration ||
      record.fence.connectionId !== fence.connectionId
    ) return;
    await drainRecord(record, reason, "shutdown");
  };

  const shutdown = (
    reason = "hypervisor_shutdown",
  ): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    acceptingConnections = false;
    if (!hostAbort.signal.aborted) hostAbort.abort(reason);
    shuttingDown = (async () => {
      for (const binding of transportBindings) binding.close(reason);
      const active = [...records];
      await Promise.allSettled(
        active.map((record) => drainRecord(record, reason, "shutdown")),
      );
      await Promise.allSettled(
        [...records].map(async (record) => {
          if (
            record.transport !== undefined &&
            record.connectionId !== undefined &&
            record.connection !== undefined
          ) {
            await record.transport.sendControl({
              protocol: WORKER_PROTOCOL,
              type: "shutdown",
              connectionId: record.connectionId,
              reason,
            }).catch(() => undefined);
          }
          await closeRecord(
            record,
            NORMAL_CLOSE_CODE,
            "shutdown",
            "shutdown",
          );
        }),
      );
      lifecycle.stopLeaseSweep();
      options.signal?.removeEventListener("abort", shutdownFromSignal);
    })();
    return shuttingDown;
  };

  const shutdownFromSignal = (): void => {
    void shutdown(String(options.signal?.reason ?? "hypervisor_aborted"));
  };
  if (options.signal?.aborted) queueMicrotask(shutdownFromSignal);
  else {
    options.signal?.addEventListener("abort", shutdownFromSignal, {
      once: true,
    });
  }

  const snapshot: Hypervisor["snapshot"] = () => {
    const admissionSnapshot = admission.snapshot();
    const work = {
      offered: 0,
      claimed: 0,
      committing: 0,
      committed: 0,
      cancelling: 0,
      reschedulable: 0,
      completed: 0,
      cancelled: 0,
      failed: 0,
      indeterminate: 0,
    };
    for (const operation of dispatcher.list()) work[operation.status]++;
    return Object.freeze({
      acceptingConnections,
      connections: records.size,
      unauthenticatedConnections: admissionSnapshot.unauthenticatedConnections,
      authenticatedConnections: admissionSnapshot.authenticatedConnections,
      handshakeOperations: admissionSnapshot.handshakeOperations,
      readyOperations: admissionSnapshot.readyOperations,
      sessions: sessions.list().length,
      inProcessWorkers: [...records].filter((record) =>
        record.transportType === "in-process" && record.phase === "ready"
      ).length,
      pendingAcceptanceCommits: acceptanceAdmission.pending,
      pendingAcceptanceCommitsByWorker: Object.freeze(
        Array.from(
          acceptanceAdmission.byWorker,
          ([workerId, count]) =>
            Object.freeze({ workerId, count }),
        ).sort((left, right) => left.workerId.localeCompare(right.workerId)),
      ),
      work: Object.freeze(work),
    });
  };

  const hypervisor = Object.freeze({
    prepare,
    dispatch,
    drain,
    shutdownWorker,
    shutdownSession,
    shutdown,
    snapshot,
    config,
    sessions,
  });
  return hypervisor;
}
