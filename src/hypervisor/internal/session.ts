import {
  type ControlFrame,
  createReadyAckFrame,
  type HelloFrame,
  type ReadyFrame,
  WORKER_PROTOCOL,
} from "../../protocol/index.ts";
import {
  createSessionFence,
  type SessionRegistry,
} from "../../supervisor/index.ts";
import type { HypervisorLifecycleCallbacks } from "../../lifecycle/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  HypervisorDisconnectReason,
  HypervisorOptions,
  HypervisorScheduler,
} from "../types.ts";
import type { AdmissionController } from "./admission.ts";
import type { ConnectionDirectory } from "./directory.ts";
import type { CloseRecord, ConnectionRecord, DrainRecord } from "./model.ts";
import {
  assertCurrentFrame,
  cancelConnectionTimer,
  copyBootstrap,
  createHypervisorError,
  ensureOpen,
  MAX_TIMER_MS,
  POLICY_CLOSE_CODE,
} from "./primitives.ts";

export type SessionProtocolController = Readonly<{
  welcome(record: ConnectionRecord, frame: HelloFrame): Promise<void>;
  ready(record: ConnectionRecord, frame: ReadyFrame): Promise<void>;
  handleFrame(
    record: ConnectionRecord,
    frame: ControlFrame,
    disposition: "deliver" | "discard",
  ): Promise<void>;
}>;

/**
 * Owns authenticated Welcome/Ready publication and ready-session control.
 *
 * Durable lifecycle hooks remain in the connection's ordered frame path and
 * fenced SessionRegistry mutation remains the only routability publication.
 */
export function createSessionProtocolController(
  options: Readonly<{
    hypervisor: HypervisorOptions;
    callbacks: HypervisorLifecycleCallbacks;
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    directory: ConnectionDirectory;
    admission: AdmissionController;
    closeRecord: CloseRecord;
    drainRecord: DrainRecord;
    finishDrain(record: ConnectionRecord, reason: string): Promise<void>;
    handleWorkControl(
      record: ConnectionRecord,
      frame: ControlFrame,
      disposition: "deliver" | "discard",
    ): Promise<boolean>;
    rejectRecord(
      record: ConnectionRecord,
      code: string,
      reason: HypervisorDisconnectReason,
      closeCode?: number,
    ): Promise<void>;
  }>,
): SessionProtocolController {
  const awaitExternal = options.admission.awaitExternal;
  const requireAdmit = () => {
    const admit = options.hypervisor.admit;
    if (admit === undefined) {
      throw Object.assign(
        new Error("Hypervisor does not admit Workers"),
        { code: "authentication_failed" },
      );
    }
    return admit;
  };

  const welcome = async (
    record: ConnectionRecord,
    hello: HelloFrame,
  ): Promise<void> => {
    ensureOpen(record);
    record.hello = hello;
    const connectionId = options.directory.reserveId(record);
    await awaitExternal(
      record,
      "handshake",
      () =>
        options.callbacks.onConnect?.(Object.freeze({
          stage: "connect" as const,
          stageId: `connect:${connectionId}`,
          callbackAttempt: 1,
          signal: record.abort.signal,
          connectionId,
        })),
    );
    ensureOpen(record);
    const admitContext = Object.freeze({
      stage: "admit" as const,
      stageId: `admit:${hello.identity.workerId}:${hello.handshakeId}`,
      callbackAttempt: 1,
      signal: record.abort.signal,
      identity: hello.identity,
      credential: hello.credential,
      handshakeId: hello.handshakeId,
      workloads: hello.workloads,
      capacity: hello.capacity,
    });
    const admitted = await awaitExternal(
      record,
      "handshake",
      () => requireAdmit()(admitContext),
    );
    ensureOpen(record);
    const definition = admitted?.definition;
    if (
      definition === undefined ||
      definition.workerId !== hello.identity.workerId ||
      !Number.isSafeInteger(admitted.sessionGeneration) ||
      admitted.sessionGeneration < 1 ||
      admitted.authenticatedWith !== hello.credential.kind ||
      admitted.resume?.credential.kind !== "resume" ||
      typeof admitted.resume.credential.capability !== "string" ||
      admitted.resume.credential.capability.length === 0 ||
      !Number.isSafeInteger(admitted.resume.expiresAtMs) ||
      admitted.resume.expiresAtMs <= options.clock()
    ) {
      throw Object.assign(new Error("admit returned an invalid result"), {
        code: "authentication_failed",
      });
    }
    if (
      hello.capacity > definition.capacity ||
      hello.workloads.some((workload) =>
        !definition.workloads.includes(workload)
      )
    ) {
      throw Object.assign(
        new Error("worker declaration exceeds its definition"),
        { code: "definition_mismatch" },
      );
    }
    options.admission.assertAuthenticatedAvailable();
    options.admission.reserveAuthenticated(record);

    await awaitExternal(
      record,
      "handshake",
      () =>
        options.callbacks.onAdmit?.(Object.freeze({
          ...admitContext,
          ...admitted,
        })),
    );
    ensureOpen(record);

    options.admission.completeAuthentication(record);
    record.phase = "authenticated";
    record.exchange = Object.freeze({
      identity: hello.identity,
      handshakeId: hello.handshakeId,
      sessionGeneration: admitted.sessionGeneration,
      authenticatedWith: admitted.authenticatedWith,
      resume: Object.freeze({
        identity: hello.identity,
        credential: admitted.resume.credential,
        expiresAtMs: admitted.resume.expiresAtMs,
      }),
    });
    record.definition = definition;
    record.fence = createSessionFence({
      identity: hello.identity,
      connectionId,
      sessionGeneration: admitted.sessionGeneration,
    });
    record.sessionPhase = "authenticated";
    options.directory.publish(record);

    await awaitExternal(
      record,
      "handshake",
      () =>
        options.callbacks.onHandshake?.(Object.freeze({
          stage: "handshake" as const,
          stageId: `handshake:${
            record.fence!.connectionId
          }:${hello.handshakeId}`,
          callbackAttempt: 1,
          signal: record.abort.signal,
          fence: record.fence!,
          definition,
        })),
    );
    ensureOpen(record);
    const bootstrap = copyBootstrap(admitted.bootstrap ?? {});
    ensureOpen(record);
    await record.transport!.sendControl({
      protocol: WORKER_PROTOCOL,
      type: "welcome",
      connectionId,
      heartbeatIntervalMs: options.config.heartbeatIntervalMs,
      leaseTimeoutMs: options.config.leaseTimeoutMs,
      resumeCapability: admitted.resume.credential.capability,
      resumeExpiresAtMs: admitted.resume.expiresAtMs,
      bootstrap,
    });
    ensureOpen(record);
    cancelConnectionTimer(options.scheduler, record, "handshakeTimer");
    record.readyTimer = options.scheduler.schedule(() => {
      void options.rejectRecord(record, "ready_timeout", "ready_timeout");
    }, options.config.readyTimeoutMs);
  };

  const ready = async (
    record: ConnectionRecord,
    frame: ReadyFrame,
  ): Promise<void> => {
    ensureOpen(record);
    if (
      record.hello === undefined ||
      record.exchange === undefined ||
      record.definition === undefined ||
      record.fence === undefined
    ) {
      throw createHypervisorError(
        "invalid_state",
        "Ready arrived without an authenticated Welcome",
      );
    }

    try {
      ensureOpen(record);
      const attachment = options.sessions.attach({
        identity: record.hello.identity,
        connectionId: record.fence.connectionId,
        sessionGeneration: record.exchange.sessionGeneration,
        transportType: record.transportType,
        workloads: record.hello.workloads,
        capacity: record.hello.capacity,
        leaseTimeoutMs: options.config.leaseTimeoutMs,
      });
      record.sessionPhase = "connected";

      if (attachment.replaced !== undefined) {
        const replaced = options.directory.get(
          attachment.replaced.connectionId,
        );
        if (replaced !== undefined && replaced !== record) {
          void options.closeRecord(
            replaced,
            POLICY_CLOSE_CODE,
            "session_replaced",
            "session_replaced",
          );
        }
      }

      if (options.callbacks.onReady !== undefined) {
        await awaitExternal(
          record,
          "ready",
          () =>
            options.callbacks.onReady!(Object.freeze({
              stage: "ready" as const,
              stageId: `ready:${record.fence!.connectionId}:${
                record.fence!.sessionGeneration
              }`,
              callbackAttempt: 1,
              fence: record.fence!,
              definition: record.definition!,
              metadata: frame.metadata,
              signal: record.abort.signal,
            })),
        );
        ensureOpen(record);
      }

      ensureOpen(record);
      options.sessions.assertCurrent(record.fence);
      options.sessions.markReady(record.fence);
      record.sessionPhase = "ready";
      record.phase = "ready";
      const readyAcknowledgement = record.transport!.sendControl(
        createReadyAckFrame({ connectionId: record.fence.connectionId }),
        { signal: record.abort.signal },
      );
      // The acknowledgement already occupies the serialized send queue before
      // new work is admitted, so every WorkOpen is ordered after it on wire.
      record.acceptingWork = true;
      await readyAcknowledgement;
      ensureOpen(record);
      options.sessions.assertCurrent(record.fence);
      cancelConnectionTimer(options.scheduler, record, "readyTimer");
      // Connection-age rotation protects physical WebSocket infrastructure.
      // An in-process event-fabric connection has no intermediary lifetime and
      // may intentionally host a durable stream (for example a database
      // session or realtime attachment) for the lifetime of its application.
      if (record.transportType === "websocket") {
        const readyDrainAfterMs = Math.max(
          1,
          options.config.maxConnectionAgeMs -
            options.config.proactiveDrainMarginMs -
            Math.max(0, options.clock() - record.connectedAtMs),
        );
        record.ageTimer = options.scheduler.schedule(() => {
          void options.drainRecord(
            record,
            "connection_age",
            "rotate",
            Math.min(
              options.config.shutdownTimeoutMs,
              options.config.proactiveDrainMarginMs,
            ),
          );
        }, Math.min(MAX_TIMER_MS, readyDrainAfterMs));
      }
    } catch (error) {
      if (record.fence !== undefined) options.sessions.detach(record.fence);
      throw error;
    }
  };

  const handleFrame = async (
    record: ConnectionRecord,
    frame: ControlFrame,
    disposition: "deliver" | "discard",
  ): Promise<void> => {
    assertCurrentFrame(record, options.sessions);
    if (await options.handleWorkControl(record, frame, disposition)) return;
    if (frame.type === "heartbeat") {
      if (options.callbacks.onHeartbeat !== undefined) {
        await awaitExternal(
          record,
          "ready",
          () =>
            options.callbacks.onHeartbeat!(Object.freeze({
              stage: "heartbeat" as const,
              stageId: `heartbeat:${
                record.fence!.connectionId
              }:${frame.sequence}`,
              callbackAttempt: 1,
              fence: record.fence!,
              definition: record.definition!,
              sequence: frame.sequence,
              inflight: frame.inflight,
              availableCapacity: frame.availableCapacity,
              metadata: frame.metadata,
              signal: record.abort.signal,
            })),
        );
        ensureOpen(record);
      }
      ensureOpen(record);
      options.sessions.assertCurrent(record.fence!);
      options.sessions.heartbeat(record.fence!, { sequence: frame.sequence });
      return;
    }
    if (frame.type === "drained") {
      options.sessions.markDrained(record.fence!);
      record.sessionPhase = "drained";
      await options.finishDrain(record, "drain_complete");
      return;
    }
    if (frame.type === "protocol_error") {
      await options.closeRecord(
        record,
        POLICY_CLOSE_CODE,
        "peer_protocol_error",
        "protocol_rejected",
      );
      return;
    }
    throw createHypervisorError(
      "invalid_state",
      `work frame ${frame.type} is not yet attached to an operation`,
      { identity: record.hello?.identity },
    );
  };

  return Object.freeze({ welcome, ready, handleFrame });
}
