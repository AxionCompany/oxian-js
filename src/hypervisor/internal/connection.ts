import {
  type ControlFrame,
  type HelloFrame,
  type ReadyFrame,
  WORKER_PROTOCOL,
} from "../../protocol/index.ts";
import type { SessionRegistry } from "../../supervisor/index.ts";
import {
  createFrameConnection,
  createProtocolTransport,
  expectSocketConnection,
  type SocketConnection,
} from "../../transport/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  Hypervisor,
  HypervisorDisconnectReason,
  HypervisorRequestDecision,
  HypervisorScheduler,
} from "../types.ts";
import type { AdmissionController } from "./admission.ts";
import type { ConnectionDirectory } from "./directory.ts";
import type { CloseRecord, ConnectionRecord } from "./model.ts";
import {
  assertCurrentFrame,
  authenticationCode,
  cancelConnectionTimer,
  copyPeerClose,
  createHypervisorError,
  ensureOpen,
  errorCode,
  INTERNAL_CLOSE_CODE,
  POLICY_CLOSE_CODE,
  websocketRequestError,
} from "./primitives.ts";

export type ConnectionAdmission = Readonly<{
  prepare: Hypervisor["prepare"];
  accept(
    connection: SocketConnection,
    negotiatedProtocol?: string,
    transportType?: "in-process" | "websocket",
  ): void;
}>;

export function createConnectionAdmission(
  options: Readonly<{
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    directory: ConnectionDirectory;
    admission: AdmissionController;
    isAcceptingConnections(): boolean;
    fallback?: (
      request: Request,
    ) => Response | Promise<Response>;
    armLeaseSweep(): void;
    welcome(record: ConnectionRecord, frame: HelloFrame): Promise<void>;
    ready(record: ConnectionRecord, frame: ReadyFrame): Promise<void>;
    handleReadyFrame(
      record: ConnectionRecord,
      frame: ControlFrame,
      disposition: "deliver" | "discard",
    ): Promise<void>;
    handleWorkData(
      record: ConnectionRecord,
      frame: Readonly<{ streamId: string; payload: Uint8Array }>,
      disposition: "deliver" | "discard",
    ): Promise<void>;
    closeRecord: CloseRecord;
    rejectRecord(
      record: ConnectionRecord,
      code: string,
      reason: HypervisorDisconnectReason,
      closeCode?: number,
    ): Promise<void>;
    cleanupConnection(record: ConnectionRecord): Promise<void>;
  }>,
): ConnectionAdmission {
  const runConnection = async (
    record: ConnectionRecord,
    negotiatedProtocol: string | undefined,
  ): Promise<void> => {
    try {
      record.connection = await createFrameConnection(record.socket!, {
        negotiatedProtocol,
        signal: record.abort.signal,
        maxInboundFrames: options.config.maxInboundMessages,
        maxInboundBytes: options.config.maxInboundBytes,
        maxBufferedAmountBytes: options.config.maxBufferedAmountBytes,
        bufferedAmountLowWaterBytes: Math.max(
          1,
          Math.min(
            512 * 1024,
            Math.floor(options.config.maxBufferedAmountBytes / 2),
          ),
        ),
      });
      record.transport = await createProtocolTransport({
        connection: record.connection,
        role: "hypervisor",
        signal: record.abort.signal,
        maxInboundMessages: options.config.maxInboundMessages,
        maxInboundBytes: options.config.maxInboundBytes,
        protocol: {
          maxCapacity: options.config.maxWorkerCapacity,
          maxLifetimeStreams: options.config.maxLifetimeStreams,
          maxDataPayloadBytes: options.config.maxDataPayloadBytes,
          maxReceiveCreditBytes: options.config.maxReceiveCreditBytes,
        },
      });
      // Wire close details remain diagnostic and untrusted. The observer owns
      // prompt idempotent cleanup even if an ordered lifecycle hook is stalled.
      void record.transport.closed.then(
        (close) => {
          record.peerClose ??= copyPeerClose(close);
          record.disconnectReason ??= "peer_closed";
          void options.cleanupConnection(record).catch(() => undefined);
        },
        () => {
          record.disconnectReason ??= "peer_closed";
          void options.cleanupConnection(record).catch(() => undefined);
        },
      );
      record.handshakeTimer = options.scheduler.schedule(() => {
        void options.rejectRecord(
          record,
          "handshake_timeout",
          "handshake_timeout",
        );
      }, options.config.handshakeTimeoutMs);
      for await (const message of record.transport.messages()) {
        ensureOpen(record);
        if (message.kind === "data") {
          assertCurrentFrame(record, options.sessions);
          await options.handleWorkData(
            record,
            message.acceptance.frame,
            message.acceptance.disposition,
          );
          continue;
        }
        const frame = message.acceptance.frame;
        if (record.phase === "unauthenticated") {
          if (frame.type !== "hello") {
            throw createHypervisorError(
              "authentication_failed",
              "first worker frame must be hello",
            );
          }
          if (frame.capacity > options.config.maxWorkerCapacity) {
            throw Object.assign(
              new Error("worker capacity exceeds gateway admission limit"),
              { code: "capacity_exceeded" },
            );
          }
          await options.welcome(record, frame);
          continue;
        }
        if (record.phase === "authenticated") {
          if (frame.type === "protocol_error") {
            await options.closeRecord(
              record,
              POLICY_CLOSE_CODE,
              "peer_protocol_error",
              "protocol_rejected",
            );
            continue;
          }
          if (frame.type !== "ready") {
            throw createHypervisorError(
              "invalid_state",
              "worker must send Ready after Welcome",
              { identity: record.hello?.identity },
            );
          }
          await options.ready(record, frame);
          continue;
        }
        await options.handleReadyFrame(
          record,
          frame,
          message.acceptance.disposition,
        );
      }
    } catch (error) {
      if (record.phase !== "closed") {
        const code = record.phase === "unauthenticated"
          ? authenticationCode(error)
          : errorCode(error) ?? "connection_failed";
        const disconnectReason: HypervisorDisconnectReason =
          record.phase === "unauthenticated"
            ? "authentication_rejected"
            : code === "connection_failed"
            ? "connection_failed"
            : "protocol_rejected";
        await options.rejectRecord(
          record,
          code,
          disconnectReason,
          code === "connection_failed"
            ? INTERNAL_CLOSE_CODE
            : POLICY_CLOSE_CODE,
        );
      }
    } finally {
      if (record.transport !== undefined) {
        const closed = await record.transport.closed.catch(() => undefined);
        if (closed !== undefined) {
          record.peerClose ??= copyPeerClose(closed);
        }
        record.disconnectReason ??= "peer_closed";
      }
      await options.cleanupConnection(record);
    }
  };

  const reserve = (
    transportType: "in-process" | "websocket",
  ): Extract<
    HypervisorRequestDecision,
    Readonly<{ kind: "upgrade" }>
  > => {
    const record: ConnectionRecord = {
      transportType,
      phase: "pending",
      connectedAtMs: options.clock(),
      acceptingWork: false,
      openedStreams: 0,
      authenticatedSlot: false,
      unauthenticatedSlot: false,
      handshakeExternalOperations: 0,
      readyExternalOperations: 0,
      abort: new AbortController(),
      pending: new Map(),
    };
    options.directory.add(record);
    options.admission.admit(record);
    options.armLeaseSweep();
    let state: "pending" | "attached" | "cancelled" = "pending";

    const cancel = (_reason = "upgrade_failed"): void => {
      if (state !== "pending") return;
      state = "cancelled";
      record.disconnectReason = "connection_failed";
      cancelConnectionTimer(options.scheduler, record, "attachmentTimer");
      void options.cleanupConnection(record).catch(() => undefined);
    };

    const attach = (
      value: SocketConnection,
      negotiatedProtocol?: string,
    ): void => {
      const connection = expectSocketConnection(value);
      if (state !== "pending") {
        try {
          connection.close(4400, "admission_expired");
        } catch {
          // The adapter still owns its rejected native connection.
        }
        throw new TypeError("Hypervisor admission is no longer attachable");
      }
      const selectedProtocol = connection.protocol || negotiatedProtocol;
      if (
        selectedProtocol !== WORKER_PROTOCOL ||
        (connection.protocol !== "" && negotiatedProtocol !== undefined &&
          connection.protocol !== negotiatedProtocol)
      ) {
        try {
          connection.close(4400, "unsupported_protocol");
        } catch {
          // Releasing admission remains authoritative.
        }
        cancel("unsupported_protocol");
        throw new TypeError(
          `worker connection must negotiate ${WORKER_PROTOCOL}`,
        );
      }
      state = "attached";
      cancelConnectionTimer(options.scheduler, record, "attachmentTimer");
      record.socket = connection;
      record.phase = "unauthenticated";
      void runConnection(record, selectedProtocol);
    };

    record.attachmentTimer = options.scheduler.schedule(() => {
      if (state !== "pending") return;
      state = "cancelled";
      record.attachmentTimer = undefined;
      record.disconnectReason = "handshake_timeout";
      void options.cleanupConnection(record).catch(() => undefined);
    }, options.config.handshakeTimeoutMs);

    return Object.freeze({
      kind: "upgrade" as const,
      protocol: WORKER_PROTOCOL,
      attach,
      cancel,
    });
  };

  const prepare: Hypervisor["prepare"] = (request) => {
    const admissionSnapshot = options.admission.snapshot();
    const response = websocketRequestError(
      request,
      options.config,
      options.isAcceptingConnections(),
      options.directory.records.size,
      admissionSnapshot.unauthenticatedConnections,
      admissionSnapshot.handshakeOperations,
    );
    if (response !== undefined) {
      return Object.freeze({
        kind: "response" as const,
        response,
      });
    }
    return reserve("websocket");
  };

  const accept: ConnectionAdmission["accept"] = (
    connection,
    negotiatedProtocol = WORKER_PROTOCOL,
    transportType = "in-process",
  ) => {
    if (!options.isAcceptingConnections()) {
      connection.close(4403, "hypervisor_not_accepting_connections");
      throw new TypeError("Hypervisor is not accepting Worker connections");
    }
    const admissionSnapshot = options.admission.snapshot();
    if (
      options.directory.records.size >= options.config.maxConnections ||
      admissionSnapshot.unauthenticatedConnections >=
        options.config.maxUnauthenticatedConnections ||
      admissionSnapshot.handshakeOperations >=
        options.config.maxUnauthenticatedConnections
    ) {
      connection.close(4429, "connection_admission_exhausted");
      throw new TypeError("Hypervisor Worker admission is exhausted");
    }
    reserve(transportType).attach(connection, negotiatedProtocol);
  };

  return Object.freeze({ prepare, accept });
}
