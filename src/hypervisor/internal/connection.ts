import {
  type ControlFrame,
  type HelloFrame,
  type ReadyFrame,
  WORKER_PROTOCOL,
} from "../../protocol/index.ts";
import type { SessionRegistry } from "../../supervisor/index.ts";
import { createWebSocketTransport } from "../../transport/index.ts";
import type { HypervisorConfig } from "../config.ts";
import type {
  Hypervisor,
  HypervisorDisconnectReason,
  HypervisorScheduler,
} from "../types.ts";
import type { AdmissionController } from "./admission.ts";
import type { ConnectionDirectory } from "./directory.ts";
import type { CloseRecord, ConnectionRecord } from "./model.ts";
import {
  assertCurrentFrame,
  authenticationCode,
  copyPeerClose,
  createHypervisorError,
  ensureOpen,
  errorCode,
  INTERNAL_CLOSE_CODE,
  POLICY_CLOSE_CODE,
  websocketRequestError,
} from "./primitives.ts";

export function createConnectionEndpoint(
  options: Readonly<{
    config: HypervisorConfig;
    clock: () => number;
    scheduler: HypervisorScheduler;
    sessions: SessionRegistry;
    directory: ConnectionDirectory;
    admission: AdmissionController;
    isAcceptingConnections(): boolean;
    fallback?: Hypervisor["fetch"];
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
): Hypervisor["fetch"] {
  const runConnection = async (record: ConnectionRecord): Promise<void> => {
    try {
      record.transport = await createWebSocketTransport({
        socket: record.socket,
        role: "hypervisor",
        negotiatedProtocol: WORKER_PROTOCOL,
        signal: record.abort.signal,
        maxInboundMessages: options.config.maxInboundMessages,
        maxInboundBytes: options.config.maxInboundBytes,
        maxBufferedAmountBytes: options.config.maxBufferedAmountBytes,
        protocol: {
          maxCapacity: options.config.maxWorkerCapacity,
          maxLifetimeStreams: options.config.maxLifetimeStreams,
          maxDataPayloadBytes: options.config.maxDataPayloadBytes,
          maxReceiveCreditBytes: options.config.maxReceiveCreditBytes,
        },
        bufferedAmountLowWaterBytes: Math.max(
          1,
          Math.min(
            512 * 1024,
            Math.floor(options.config.maxBufferedAmountBytes / 2),
          ),
        ),
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

  return (request) => {
    const url = new URL(request.url);
    if (url.pathname !== options.config.workerPath) {
      return options.fallback?.(request) ??
        new Response("Not Found", { status: 404 });
    }
    const admissionSnapshot = options.admission.snapshot();
    const response = websocketRequestError(
      request,
      options.config,
      options.isAcceptingConnections(),
      options.directory.records.size,
      admissionSnapshot.unauthenticatedConnections,
      admissionSnapshot.handshakeOperations,
    );
    if (response !== undefined) return response;

    let upgraded: ReturnType<typeof Deno.upgradeWebSocket>;
    try {
      upgraded = Deno.upgradeWebSocket(request, {
        protocol: WORKER_PROTOCOL,
      });
    } catch {
      return new Response("Invalid WebSocket upgrade", { status: 400 });
    }
    const record: ConnectionRecord = {
      socket: upgraded.socket,
      phase: "unauthenticated",
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
    void runConnection(record);
    return upgraded.response;
  };
}
