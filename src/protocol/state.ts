import { validateWorkDataFrame } from "./binary.ts";
import { decodeControlFrame } from "./control.ts";
import { createCreditWindow, type CreditWindow } from "./flow_control.ts";
import { WORKER_PROTOCOL_LIMITS } from "./limits.ts";
import type { ControlFrame, WorkDataFrame, WorkerIdentity } from "./types.ts";
import {
  type ProtocolViolationCode,
  throwProtocolViolation,
} from "./violation.ts";

export type ProtocolRole = "hypervisor" | "worker";
export type ProtocolDirection = "sent" | "received";
export type ProtocolFrameDisposition = "deliver" | "discard";

export type ProtocolPhase =
  | "new"
  | "hello"
  | "welcomed"
  | "readied"
  | "ready"
  | "draining"
  | "drained"
  | "shutdown"
  | "protocol_error";

export type WorkStreamTerminal = "end" | "cancel" | "error";

export type WorkStreamStatus =
  | "open"
  | "accepted"
  | "started"
  | "half_closed"
  | "terminating";

export type WorkStreamSnapshot = Readonly<{
  streamId: string;
  status: WorkStreamStatus;
  accepted: boolean;
  started: boolean;
  sentTerminal?: WorkStreamTerminal;
  receivedTerminal?: WorkStreamTerminal;
  nextSentSequence: number;
  nextReceivedSequence: number;
  sendCredit: number;
  receiveCredit: number;
}>;

export type ProtocolStateSnapshot = Readonly<{
  role: ProtocolRole;
  phase: ProtocolPhase;
  identity?: WorkerIdentity;
  workloads?: readonly string[];
  connectionId?: string;
  capacity?: number;
  nextHeartbeatSequence: number;
  activeStreamCount: number;
  usedStreamCount: number;
  maxLifetimeStreams: number;
  streams: readonly WorkStreamSnapshot[];
}>;

export type ProtocolFrameAcceptance<T> = Readonly<{
  frame: T;
  /**
   * State transitions are always applied. `discard` means an inbound work event
   * crossed a locally-sent cancel/error and must not reach workload code.
   */
  disposition: ProtocolFrameDisposition;
}>;

export type ProtocolOrderValidator = Readonly<{
  acceptBinary(
    direction: ProtocolDirection,
    frame: unknown,
  ): ProtocolFrameAcceptance<WorkDataFrame>;
  acceptControl(
    direction: ProtocolDirection,
    frame: unknown,
  ): ProtocolFrameAcceptance<ControlFrame>;
  snapshot(): ProtocolStateSnapshot;
}>;

export type ProtocolOrderValidatorOptions = Readonly<{
  role: ProtocolRole;
  maxCapacity?: number;
  maxLifetimeStreams?: number;
  maxDataPayloadBytes?: number;
  maxReceiveCreditBytes?: number;
}>;

type MutableWorkStream = {
  streamId: string;
  accepted: boolean;
  started: boolean;
  sentTerminal: WorkStreamTerminal | undefined;
  receivedTerminal: WorkStreamTerminal | undefined;
  nextSentSequence: number;
  nextReceivedSequence: number;
  sentMetadata: boolean;
  receivedMetadata: boolean;
  sendCredit: CreditWindow;
  receiveCredit: CreditWindow;
};

type NormalTerminalTombstone = {
  streamId: string;
  sentAborted: boolean;
  receivedAborted: boolean;
};

const UINT32_MAX = 0xffff_ffff;

const WORKER_ONLY = new Set<ControlFrame["type"]>([
  "hello",
  "ready",
  "heartbeat",
  "drained",
  "work.accepted",
  "work.metadata",
]);

const HYPERVISOR_ONLY = new Set<ControlFrame["type"]>([
  "welcome",
  "ready_ack",
  "drain",
  "shutdown",
  "work.open",
  "work.start",
]);

function fail(
  message: string,
  code: ProtocolViolationCode = "invalid_protocol_order",
): never {
  return throwProtocolViolation(
    code,
    `Invalid Oxian protocol order: ${message}`,
  );
}

function expectAdmissionLimit(
  value: unknown,
  name: string,
  hardLimit: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (value > hardLimit) {
    throw new TypeError(
      `${name} must not exceed the oxian.worker.v1 limit of ${hardLimit}`,
    );
  }
  return value;
}

function senderFor(
  role: ProtocolRole,
  direction: ProtocolDirection,
): ProtocolRole {
  if (direction === "sent") return role;
  return role === "worker" ? "hypervisor" : "worker";
}

function isAbortTerminal(
  terminal: WorkStreamTerminal | undefined,
): boolean {
  return terminal === "cancel" || terminal === "error";
}

function terminalFor(
  stream: MutableWorkStream,
  direction: ProtocolDirection,
): WorkStreamTerminal | undefined {
  return direction === "sent" ? stream.sentTerminal : stream.receivedTerminal;
}

function oppositeTerminalFor(
  stream: MutableWorkStream,
  direction: ProtocolDirection,
): WorkStreamTerminal | undefined {
  return direction === "sent" ? stream.receivedTerminal : stream.sentTerminal;
}

function setTerminal(
  stream: MutableWorkStream,
  direction: ProtocolDirection,
  terminal: WorkStreamTerminal,
): void {
  if (direction === "sent") {
    stream.sentTerminal = terminal;
  } else {
    stream.receivedTerminal = terminal;
  }
}

function streamStatus(stream: MutableWorkStream): WorkStreamStatus {
  if (
    isAbortTerminal(stream.sentTerminal) ||
    isAbortTerminal(stream.receivedTerminal)
  ) {
    return "terminating";
  }
  if (
    stream.sentTerminal === "end" ||
    stream.receivedTerminal === "end"
  ) {
    return "half_closed";
  }
  if (stream.started) return "started";
  if (stream.accepted) return "accepted";
  return "open";
}

function createAcceptance<T>(
  frame: T,
  disposition: ProtocolFrameDisposition,
): ProtocolFrameAcceptance<T> {
  return Object.freeze({ frame, disposition });
}

/**
 * Creates a connection-local protocol order validator.
 *
 * `work.accepted` only reserves a stream. The Hypervisor must establish the
 * no-replay boundary before sending `work.start`; the worker must not invoke
 * workload code before receiving start.
 */
export function createProtocolOrderValidator(
  options: ProtocolOrderValidatorOptions,
): ProtocolOrderValidator {
  if (options.role !== "hypervisor" && options.role !== "worker") {
    throw new TypeError("role must be hypervisor or worker");
  }

  const role = options.role;
  const maxCapacity = expectAdmissionLimit(
    options.maxCapacity ?? WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    "maxCapacity",
    WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
  );
  const maxLifetimeStreams = expectAdmissionLimit(
    options.maxLifetimeStreams ??
      WORKER_PROTOCOL_LIMITS.maxLifetimeStreams,
    "maxLifetimeStreams",
    WORKER_PROTOCOL_LIMITS.maxLifetimeStreams,
  );
  const maxDataPayloadBytes = expectAdmissionLimit(
    options.maxDataPayloadBytes ??
      WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
    "maxDataPayloadBytes",
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
  );
  const maxReceiveCreditBytes = expectAdmissionLimit(
    options.maxReceiveCreditBytes ??
      WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
    "maxReceiveCreditBytes",
    WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
  );

  let phase: ProtocolPhase = "new";
  let identity: WorkerIdentity | undefined;
  let workloads: readonly string[] | undefined;
  let workloadSet: ReadonlySet<string> | undefined;
  let connectionId: string | undefined;
  let capacity: number | undefined;
  let nextHeartbeatSequence = 0;
  const streams = new Map<string, MutableWorkStream>();
  // Normal End/End streams retain only bounded wire-order state. They no
  // longer consume capacity or block Drained, but either side may still have
  // sent an End→Abort upgrade before observing the peer's End.
  const normalTerminalTombstones = new Map<
    string,
    NormalTerminalTombstone
  >();
  const usedStreamIds = new Set<string>();

  const ensureDirection = (
    direction: ProtocolDirection,
    frame: ControlFrame,
  ): void => {
    if (direction !== "sent" && direction !== "received") {
      fail(`unsupported direction ${String(direction)}`, "invalid_direction");
    }

    const sender = senderFor(role, direction);
    if (WORKER_ONLY.has(frame.type) && sender !== "worker") {
      fail(`${frame.type} can only be sent by a worker`, "invalid_direction");
    }
    if (HYPERVISOR_ONLY.has(frame.type) && sender !== "hypervisor") {
      fail(
        `${frame.type} can only be sent by a hypervisor`,
        "invalid_direction",
      );
    }
  };

  const ensureConnection = (
    frameConnectionId: string | undefined,
    frameType: string,
  ): void => {
    if (connectionId === undefined) {
      fail(
        `${frameType} was received before a connection was welcomed`,
        "stale_connection",
      );
    }
    if (frameConnectionId === undefined) {
      fail(
        `${frameType} must include the current connectionId`,
        "stale_connection",
      );
    }
    if (frameConnectionId !== connectionId) {
      fail(
        `${frameType} uses stale connection ${frameConnectionId}; expected ${connectionId}`,
        "stale_connection",
      );
    }
  };

  const requireWorkingPhase = (frameType: string): void => {
    if (phase !== "ready" && phase !== "draining") {
      fail(`${frameType} is not allowed while connection is ${phase}`);
    }
  };

  const ensureStream = (
    streamId: string,
    frameType: string,
  ): MutableWorkStream => {
    const stream = streams.get(streamId);
    if (stream !== undefined) return stream;
    if (usedStreamIds.has(streamId)) {
      return fail(
        `${frameType} follows terminal stream ${streamId}`,
        "post_terminal_frame",
      );
    }
    return fail(`stream ${streamId} has not been opened`, "unknown_stream");
  };

  const ensureSenderMayContinue = (
    stream: MutableWorkStream,
    direction: ProtocolDirection,
    frameType: string,
  ): void => {
    const senderTerminal = terminalFor(stream, direction);
    if (senderTerminal !== undefined) {
      fail(
        `${frameType} follows ${senderTerminal} on the same stream half ${stream.streamId}`,
        "post_terminal_frame",
      );
    }
    if (
      direction === "sent" &&
      isAbortTerminal(oppositeTerminalFor(stream, direction))
    ) {
      fail(
        `${frameType} cannot be sent after the peer aborted stream ${stream.streamId}`,
        "post_terminal_frame",
      );
    }
  };

  const inboundDisposition = (
    stream: MutableWorkStream,
    direction: ProtocolDirection,
  ): ProtocolFrameDisposition =>
    direction === "received" && isAbortTerminal(stream.sentTerminal)
      ? "discard"
      : "deliver";

  const requireStarted = (
    stream: MutableWorkStream,
    frameType: string,
  ): void => {
    if (!stream.started) {
      fail(`${frameType} precedes work.start for stream ${stream.streamId}`);
    }
  };

  const finalizeIfClosed = (stream: MutableWorkStream): void => {
    const sent = stream.sentTerminal;
    const received = stream.receivedTerminal;
    if (
      sent !== undefined &&
      received !== undefined &&
      sent === "end" &&
      received === "end"
    ) {
      streams.delete(stream.streamId);
      normalTerminalTombstones.set(stream.streamId, {
        streamId: stream.streamId,
        sentAborted: false,
        receivedAborted: false,
      });
      return;
    }
    if (
      sent !== undefined &&
      received !== undefined &&
      isAbortTerminal(sent) &&
      isAbortTerminal(received)
    ) {
      streams.delete(stream.streamId);
      normalTerminalTombstones.delete(stream.streamId);
    }
  };

  const grantCredit = (
    window: CreditWindow,
    bytes: number,
  ): void => {
    try {
      window.grant(bytes);
    } catch (error) {
      if (error instanceof RangeError) {
        fail(error.message, "credit_exceeded");
      }
      throw error;
    }
  };

  const acceptControl = (
    direction: ProtocolDirection,
    input: unknown,
  ): ProtocolFrameAcceptance<ControlFrame> => {
    const frame = decodeControlFrame(input);
    ensureDirection(direction, frame);
    let disposition: ProtocolFrameDisposition = "deliver";

    switch (frame.type) {
      case "hello": {
        if (phase !== "new") fail("hello must be the first frame");
        if (frame.capacity > maxCapacity) {
          fail(
            `hello capacity ${frame.capacity} exceeds connection limit ${maxCapacity}`,
            "capacity_exceeded",
          );
        }
        identity = { ...frame.identity };
        workloads = [...frame.workloads];
        workloadSet = new Set(workloads);
        capacity = frame.capacity;
        phase = "hello";
        break;
      }

      case "welcome": {
        if (phase !== "hello") fail(`welcome is not allowed after ${phase}`);
        connectionId = frame.connectionId;
        phase = "welcomed";
        break;
      }

      case "ready": {
        if (phase !== "welcomed") fail(`ready is not allowed after ${phase}`);
        ensureConnection(frame.connectionId, frame.type);
        if (frame.capacity !== capacity) {
          fail(
            `ready capacity ${frame.capacity} differs from hello capacity ${capacity}`,
            "capacity_exceeded",
          );
        }
        phase = "readied";
        break;
      }

      case "ready_ack": {
        if (phase !== "readied") {
          fail(`ready_ack is not allowed after ${phase}`);
        }
        ensureConnection(frame.connectionId, frame.type);
        phase = "ready";
        break;
      }

      case "heartbeat": {
        requireWorkingPhase(frame.type);
        ensureConnection(frame.connectionId, frame.type);
        if (frame.sequence !== nextHeartbeatSequence) {
          fail(
            `heartbeat sequence ${frame.sequence} does not match expected ${nextHeartbeatSequence}`,
            "sequence_mismatch",
          );
        }
        if (
          capacity !== undefined &&
          frame.inflight + frame.availableCapacity > capacity
        ) {
          fail(
            "heartbeat load exceeds the declared worker capacity",
            "capacity_exceeded",
          );
        }
        nextHeartbeatSequence++;
        break;
      }

      case "drain": {
        if (phase !== "ready") fail(`drain is not allowed after ${phase}`);
        ensureConnection(frame.connectionId, frame.type);
        phase = "draining";
        break;
      }

      case "drained": {
        if (phase !== "draining") {
          fail(`drained is not allowed while connection is ${phase}`);
        }
        ensureConnection(frame.connectionId, frame.type);
        if (streams.size > 0) {
          fail("drained is not allowed while work streams remain active");
        }
        phase = "drained";
        break;
      }

      case "shutdown": {
        if (
          phase !== "welcomed" && phase !== "readied" &&
          phase !== "ready" &&
          phase !== "draining" && phase !== "drained"
        ) {
          fail(`shutdown is not allowed while connection is ${phase}`);
        }
        ensureConnection(frame.connectionId, frame.type);
        phase = "shutdown";
        break;
      }

      case "protocol_error": {
        if (phase === "shutdown" || phase === "protocol_error") {
          fail(`protocol_error is not allowed after ${phase}`);
        }
        if (connectionId !== undefined) {
          ensureConnection(frame.connectionId, frame.type);
        }
        phase = "protocol_error";
        break;
      }

      case "work.open": {
        if (phase !== "ready") {
          fail(`work.open is not allowed while connection is ${phase}`);
        }
        if (usedStreamIds.has(frame.streamId)) {
          fail(
            `stream ${frame.streamId} has already been opened`,
            "duplicate_stream",
          );
        }
        if (usedStreamIds.size >= maxLifetimeStreams) {
          fail(
            `connection reached its ${maxLifetimeStreams} stream lifetime; reconnect before opening more work`,
            "stream_limit_exceeded",
          );
        }
        if (workloadSet === undefined || !workloadSet.has(frame.workload)) {
          fail(
            `worker did not declare workload ${frame.workload}`,
            "unsupported_workload",
          );
        }
        if (capacity === undefined || streams.size >= capacity) {
          fail(
            "worker connection has no available stream capacity",
            "capacity_exceeded",
          );
        }

        usedStreamIds.add(frame.streamId);
        streams.set(frame.streamId, {
          streamId: frame.streamId,
          accepted: false,
          started: false,
          sentTerminal: undefined,
          receivedTerminal: undefined,
          nextSentSequence: 0,
          nextReceivedSequence: 0,
          sentMetadata: false,
          receivedMetadata: false,
          sendCredit: createCreditWindow({
            maxCredit: WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
          }),
          receiveCredit: createCreditWindow({
            maxCredit: maxReceiveCreditBytes,
          }),
        });
        break;
      }

      case "work.accepted": {
        requireWorkingPhase(frame.type);
        const stream = ensureStream(frame.streamId, frame.type);
        ensureSenderMayContinue(stream, direction, frame.type);
        if (stream.accepted) {
          fail(`stream ${frame.streamId} was already accepted`);
        }
        stream.accepted = true;
        // A crossed claim must still reach the Hypervisor. The durable
        // acceptance commit above this protocol layer establishes the
        // no-replay boundary before work.start is sent.
        disposition = "deliver";
        break;
      }

      case "work.start": {
        requireWorkingPhase(frame.type);
        const stream = ensureStream(frame.streamId, frame.type);
        ensureSenderMayContinue(stream, direction, frame.type);
        if (!stream.accepted) {
          fail(`work.start precedes acceptance for stream ${frame.streamId}`);
        }
        if (stream.started) {
          fail(`stream ${frame.streamId} was already started`);
        }
        stream.started = true;
        disposition = inboundDisposition(stream, direction);
        break;
      }

      case "work.metadata": {
        requireWorkingPhase(frame.type);
        const stream = ensureStream(frame.streamId, frame.type);
        requireStarted(stream, frame.type);
        ensureSenderMayContinue(stream, direction, frame.type);
        const alreadySent = direction === "sent"
          ? stream.sentMetadata
          : stream.receivedMetadata;
        if (alreadySent) {
          fail(
            `${frame.type} may appear at most once per stream direction for ${frame.streamId}`,
          );
        }
        if (direction === "sent") {
          stream.sentMetadata = true;
        } else {
          stream.receivedMetadata = true;
        }
        disposition = inboundDisposition(stream, direction);
        break;
      }

      case "work.credit": {
        requireWorkingPhase(frame.type);
        const tombstone = normalTerminalTombstones.get(frame.streamId);
        if (tombstone !== undefined) {
          if (direction === "received") {
            // The peer may have granted credit before observing our End. Since
            // WebSocket ordering is only directional, that already-sent credit
            // can arrive after the local End/End transition.
            disposition = "discard";
            break;
          }
          fail(
            `cannot grant credit for closed peer half ${frame.streamId}`,
            "post_terminal_frame",
          );
        }
        const stream = ensureStream(frame.streamId, frame.type);
        requireStarted(stream, frame.type);

        const senderTerminal = terminalFor(stream, direction);
        if (isAbortTerminal(senderTerminal)) {
          fail(
            `${frame.type} follows ${senderTerminal} on the same stream half ${stream.streamId}`,
            "post_terminal_frame",
          );
        }

        const targetTerminal = oppositeTerminalFor(stream, direction);
        if (targetTerminal !== undefined) {
          if (direction === "sent") {
            fail(
              `cannot grant credit for closed peer half ${frame.streamId}`,
              "post_terminal_frame",
            );
          }
          disposition = "discard";
          break;
        }

        if (direction === "sent") {
          grantCredit(stream.receiveCredit, frame.bytes);
        } else {
          grantCredit(stream.sendCredit, frame.bytes);
        }
        disposition = inboundDisposition(stream, direction);
        break;
      }

      case "work.end": {
        requireWorkingPhase(frame.type);
        const stream = ensureStream(frame.streamId, frame.type);
        requireStarted(stream, frame.type);
        ensureSenderMayContinue(stream, direction, frame.type);
        if (
          senderFor(role, direction) === "worker" &&
          !(direction === "sent"
            ? stream.sentMetadata
            : stream.receivedMetadata)
        ) {
          fail(
            `worker ${frame.type} precedes work.metadata for stream ${frame.streamId}`,
          );
        }
        disposition = inboundDisposition(stream, direction);
        setTerminal(stream, direction, "end");
        finalizeIfClosed(stream);
        break;
      }

      case "work.cancel":
      case "work.error": {
        requireWorkingPhase(frame.type);
        const tombstone = normalTerminalTombstones.get(frame.streamId);
        if (tombstone !== undefined) {
          const alreadyAborted = direction === "sent"
            ? tombstone.sentAborted
            : tombstone.receivedAborted;
          if (alreadyAborted) {
            fail(
              `${frame.type} follows a terminal frame on the same stream half ${tombstone.streamId}`,
              "post_terminal_frame",
            );
          }
          if (direction === "sent") {
            tombstone.sentAborted = true;
          } else {
            tombstone.receivedAborted = true;
          }
          if (tombstone.sentAborted && tombstone.receivedAborted) {
            normalTerminalTombstones.delete(tombstone.streamId);
          }
          disposition = "discard";
          break;
        }
        const stream = ensureStream(frame.streamId, frame.type);
        const senderTerminal = terminalFor(stream, direction);
        if (
          senderTerminal !== undefined &&
          senderTerminal !== "end"
        ) {
          fail(
            `${frame.type} follows a terminal frame on the same stream half ${stream.streamId}`,
            "post_terminal_frame",
          );
        }
        // End closes only this side's data. Until the peer also terminates, a
        // later cancel/error may upgrade that normal half-close into a
        // whole-stream abort (for example, when a response consumer abandons
        // output after its request body already ended). Abort terminals are
        // final and can never be repeated or downgraded.
        disposition = inboundDisposition(stream, direction);
        setTerminal(
          stream,
          direction,
          frame.type === "work.cancel" ? "cancel" : "error",
        );
        finalizeIfClosed(stream);
        break;
      }
    }

    return createAcceptance(frame, disposition);
  };

  const acceptBinary = (
    direction: ProtocolDirection,
    input: unknown,
  ): ProtocolFrameAcceptance<WorkDataFrame> => {
    if (direction !== "sent" && direction !== "received") {
      return fail(
        `unsupported direction ${String(direction)}`,
        "invalid_direction",
      );
    }
    const frame = validateWorkDataFrame(input, {
      maxPayloadBytes: maxDataPayloadBytes,
    });
    requireWorkingPhase(frame.type);
    const stream = ensureStream(frame.streamId, frame.type);
    requireStarted(stream, frame.type);
    ensureSenderMayContinue(stream, direction, frame.type);
    if (
      senderFor(role, direction) === "worker" &&
      !(direction === "sent" ? stream.sentMetadata : stream.receivedMetadata)
    ) {
      return fail(
        `worker ${frame.type} precedes work.metadata for stream ${frame.streamId}`,
      );
    }

    const expectedSequence = direction === "sent"
      ? stream.nextSentSequence
      : stream.nextReceivedSequence;
    if (expectedSequence > UINT32_MAX) {
      return fail(
        `work.data sequence is exhausted for stream ${frame.streamId}`,
        "sequence_mismatch",
      );
    }
    if (frame.sequence !== expectedSequence) {
      return fail(
        `work.data sequence ${frame.sequence} does not match expected ${expectedSequence} for stream ${frame.streamId}`,
        "sequence_mismatch",
      );
    }

    const credit = direction === "sent"
      ? stream.sendCredit
      : stream.receiveCredit;
    try {
      credit.consume(frame.payload.byteLength);
    } catch (error) {
      if (error instanceof RangeError) {
        return fail(error.message, "credit_exceeded");
      }
      throw error;
    }

    if (direction === "sent") {
      stream.nextSentSequence++;
    } else {
      stream.nextReceivedSequence++;
    }
    return createAcceptance(
      frame,
      inboundDisposition(stream, direction),
    );
  };

  const snapshot = (): ProtocolStateSnapshot => {
    const streamSnapshots = Array.from(streams.values(), (stream) => ({
      streamId: stream.streamId,
      status: streamStatus(stream),
      accepted: stream.accepted,
      started: stream.started,
      ...(stream.sentTerminal === undefined
        ? {}
        : { sentTerminal: stream.sentTerminal }),
      ...(stream.receivedTerminal === undefined
        ? {}
        : { receivedTerminal: stream.receivedTerminal }),
      nextSentSequence: stream.nextSentSequence,
      nextReceivedSequence: stream.nextReceivedSequence,
      sendCredit: stream.sendCredit.available(),
      receiveCredit: stream.receiveCredit.available(),
    }));

    return {
      role,
      phase,
      ...(identity === undefined ? {} : { identity: { ...identity } }),
      ...(workloads === undefined ? {} : { workloads: [...workloads] }),
      ...(connectionId === undefined ? {} : { connectionId }),
      ...(capacity === undefined ? {} : { capacity }),
      nextHeartbeatSequence,
      activeStreamCount: streams.size,
      usedStreamCount: usedStreamIds.size,
      maxLifetimeStreams,
      streams: streamSnapshots,
    };
  };

  return Object.freeze({
    acceptBinary,
    acceptControl,
    snapshot,
  });
}
