import {
  type ControlFrame,
  createReadyAckFrame,
  type HelloFrame,
  type ReadyFrame,
  WORKER_PROTOCOL,
} from "../../protocol/index.ts";
import {
  createSessionFence,
  isTerminalAttempt,
  type SessionRegistry,
} from "../../supervisor/index.ts";
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
  const requireWorkerAdmission = () => {
    const admission = options.hypervisor.admission;
    if (admission === undefined) {
      throw Object.assign(
        new Error("Hypervisor does not accept remote workers"),
        { code: "authentication_failed" },
      );
    }
    return admission;
  };

  const welcome = async (
    record: ConnectionRecord,
    hello: HelloFrame,
  ): Promise<void> => {
    ensureOpen(record);
    record.hello = hello;
    const attempt = await awaitExternal(
      record,
      "handshake",
      () => requireWorkerAdmission().repository.assertCurrent(hello.identity),
    );
    ensureOpen(record);
    if (isTerminalAttempt(attempt)) {
      throw Object.assign(
        new Error("worker attempt is terminal"),
        { code: "stale_attempt" },
      );
    }
    const definition = await awaitExternal(
      record,
      "handshake",
      () =>
        requireWorkerAdmission().repository.getDefinition(
          hello.identity.workerId,
        ),
    );
    ensureOpen(record);
    if (definition === undefined) {
      throw Object.assign(
        new Error("worker definition is missing"),
        { code: "stale_attempt" },
      );
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
    const connectionId = options.directory.reserveId(record);
    options.admission.reserveAuthenticated(record);

    const exchange = await awaitExternal(
      record,
      "handshake",
      () =>
        requireWorkerAdmission().authority.exchange({
          identity: hello.identity,
          credential: hello.credential,
          handshakeId: hello.handshakeId,
        }),
    );
    ensureOpen(record);

    options.admission.completeAuthentication(record);
    record.phase = "authenticated";
    record.exchange = exchange;
    record.definition = definition;
    record.fence = createSessionFence({
      identity: hello.identity,
      connectionId,
      sessionGeneration: exchange.sessionGeneration,
    });
    record.sessionPhase = "authenticated";
    options.directory.publish(record);

    const bootstrap = copyBootstrap(
      requireWorkerAdmission().bootstrap === undefined
        ? {}
        : await awaitExternal(
          record,
          "handshake",
          () =>
            requireWorkerAdmission().bootstrap!({
              identity: hello.identity,
              definition,
              exchange,
              signal: record.abort.signal,
            }),
        ),
    );
    ensureOpen(record);
    await record.transport!.sendControl({
      protocol: WORKER_PROTOCOL,
      type: "welcome",
      connectionId,
      heartbeatIntervalMs: options.config.heartbeatIntervalMs,
      leaseTimeoutMs: options.config.leaseTimeoutMs,
      resumeCapability: exchange.resume.credential.capability,
      resumeExpiresAtMs: exchange.resume.expiresAtMs,
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

    const attempt = await awaitExternal(
      record,
      "ready",
      () =>
        requireWorkerAdmission().repository.assertCurrent(
          record.hello!.identity,
        ),
    );
    ensureOpen(record);
    if (isTerminalAttempt(attempt)) {
      throw Object.assign(
        new Error("worker attempt became terminal before Ready"),
        { code: "stale_attempt" },
      );
    }
    if (requireWorkerAdmission().validateReady !== undefined) {
      await awaitExternal(
        record,
        "ready",
        () =>
          requireWorkerAdmission().validateReady!({
            identity: record.hello!.identity,
            definition: record.definition!,
            exchange: record.exchange!,
            sessionGeneration: record.exchange!.sessionGeneration,
            connectionId: record.connectionId!,
            metadata: frame.metadata,
            signal: record.abort.signal,
          }),
      );
      ensureOpen(record);
    }

    try {
      ensureOpen(record);
      const attachment = options.sessions.attach({
        identity: record.hello.identity,
        connectionId: record.fence.connectionId,
        sessionGeneration: record.exchange.sessionGeneration,
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

      if (options.hypervisor.sessionLifecycle !== undefined) {
        await awaitExternal(
          record,
          "ready",
          () =>
            options.hypervisor.sessionLifecycle!.commitReady(Object.freeze({
              fence: record.fence!,
              definition: record.definition!,
              metadata: frame.metadata,
              signal: record.abort.signal,
            })),
        );
        ensureOpen(record);
        const currentAttempt = await awaitExternal(
          record,
          "ready",
          () =>
            requireWorkerAdmission().repository.assertCurrent(
              record.hello!.identity,
            ),
        );
        ensureOpen(record);
        if (isTerminalAttempt(currentAttempt)) {
          throw Object.assign(
            new Error("worker attempt became terminal during Ready commit"),
            { code: "stale_attempt" },
          );
        }
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
      const attempt = await awaitExternal(
        record,
        "ready",
        () =>
          requireWorkerAdmission().repository.assertCurrent(
            record.fence!.identity,
          ),
      );
      ensureOpen(record);
      if (isTerminalAttempt(attempt)) {
        throw Object.assign(
          new Error("worker attempt is no longer active"),
          { code: "stale_attempt" },
        );
      }
      if (options.hypervisor.sessionLifecycle !== undefined) {
        await awaitExternal(
          record,
          "ready",
          () =>
            options.hypervisor.sessionLifecycle!.commitHeartbeat(Object.freeze({
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
        const currentAttempt = await awaitExternal(
          record,
          "ready",
          () =>
            requireWorkerAdmission().repository.assertCurrent(
              record.fence!.identity,
            ),
        );
        ensureOpen(record);
        if (isTerminalAttempt(currentAttempt)) {
          throw Object.assign(
            new Error("worker attempt became terminal during heartbeat commit"),
            { code: "stale_attempt" },
          );
        }
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
