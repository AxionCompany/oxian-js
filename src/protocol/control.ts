import {
  type ControlFrame,
  type DrainedFrame,
  type DrainFrame,
  type HeartbeatFrame,
  type HelloFrame,
  type JsonObject,
  type JsonValue,
  type ProtocolErrorFrame,
  type ReadyAckFrame,
  type ReadyFrame,
  type ShutdownFrame,
  type WelcomeFrame,
  type WorkAcceptedFrame,
  type WorkCancelFrame,
  type WorkCreditFrame,
  type WorkEndFrame,
  WORKER_PROTOCOL,
  type WorkerCredential,
  type WorkerIdentity,
  type WorkErrorFrame,
  type WorkMetadataFrame,
  type WorkOpenFrame,
  type WorkStartFrame,
} from "./types.ts";
import { WORKER_PROTOCOL_LIMITS } from "./limits.ts";
import {
  type ProtocolViolationCode,
  throwProtocolViolation,
} from "./violation.ts";

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CAPABILITY_LENGTH = 16_384;
const MAX_REASON_LENGTH = 2_048;
const MAX_ERROR_MESSAGE_LENGTH = 16_384;
const MAX_JSON_DEPTH = 32;
const UINT32_MAX = 0xffff_ffff;
const textEncoder = new TextEncoder();

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WORKLOAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const STREAM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type UnknownRecord = Record<string, unknown>;

type FrameInput<T extends ControlFrame> = Omit<T, "protocol" | "type">;

export type ControlFrameCodecOptions = Readonly<{
  maxFrameBytes?: number;
}>;

function fail(
  path: string,
  message: string,
  code: ProtocolViolationCode = "invalid_control_frame",
): never {
  return throwProtocolViolation(
    code,
    `Invalid Oxian control frame at ${path}: ${message}`,
  );
}

function expectRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "expected an object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "expected a plain object");
  }

  return value as UnknownRecord;
}

function expectExactKeys(
  record: UnknownRecord,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);

  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail(path, `unexpected field ${String(key)}`);
    }
  }

  for (const key of required) {
    if (!Object.hasOwn(record, key)) {
      fail(path, `missing field ${key}`);
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  options: {
    maxLength?: number;
    pattern?: RegExp;
  } = {},
): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail(path, "expected a non-empty string");
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    return fail(path, `must be at most ${options.maxLength} characters`);
  }
  if (options.pattern !== undefined && !options.pattern.test(value)) {
    return fail(path, "has an invalid format");
  }
  return value;
}

function expectIdentifier(value: unknown, path: string): string {
  return expectString(value, path, {
    maxLength: MAX_IDENTIFIER_LENGTH,
    pattern: IDENTIFIER_PATTERN,
  });
}

function expectWorkload(value: unknown, path: string): string {
  return expectString(value, path, {
    maxLength: MAX_IDENTIFIER_LENGTH,
    pattern: WORKLOAD_PATTERN,
  });
}

function expectStreamId(value: unknown, path: string): string {
  return expectString(value, path, {
    maxLength: 36,
    pattern: STREAM_ID_PATTERN,
  });
}

function expectInteger(
  value: unknown,
  path: string,
  options: { min: number; max?: number },
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < options.min ||
    (options.max !== undefined && value > options.max)
  ) {
    const maximum = options.max === undefined
      ? ""
      : ` and at most ${options.max}`;
    return fail(
      path,
      `expected an integer of at least ${options.min}${maximum}`,
    );
  }
  return value;
}

function expectMaxFrameBytes(options: ControlFrameCodecOptions): number {
  const maxFrameBytes = expectInteger(
    options.maxFrameBytes ?? WORKER_PROTOCOL_LIMITS.maxControlFrameBytes,
    "options.maxFrameBytes",
    { min: 1 },
  );
  if (maxFrameBytes > WORKER_PROTOCOL_LIMITS.maxControlFrameBytes) {
    throw new TypeError(
      `options.maxFrameBytes must not exceed the oxian.worker.v1 limit of ${WORKER_PROTOCOL_LIMITS.maxControlFrameBytes}`,
    );
  }
  return maxFrameBytes;
}

function enforceControlFrameSize(
  text: string,
  options: ControlFrameCodecOptions,
): void {
  const maxFrameBytes = expectMaxFrameBytes(options);
  const frameBytes = textEncoder.encode(text).byteLength;
  if (frameBytes > maxFrameBytes) {
    fail(
      "$",
      `control frame is ${frameBytes} bytes; limit is ${maxFrameBytes} bytes`,
      "control_frame_too_large",
    );
  }
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail(path, "JSON numbers must be finite");
    }
    return value;
  }

  if (typeof value !== "object") {
    return fail(path, "expected a JSON value");
  }

  if (depth >= MAX_JSON_DEPTH) {
    return fail(path, `JSON nesting exceeds ${MAX_JSON_DEPTH} levels`);
  }

  if (seen.has(value)) {
    return fail(path, "JSON values must not contain cycles");
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        cloneJsonValue(entry, `${path}[${index}]`, depth + 1, seen)
      );
    }

    const record = expectRecord(value, path);
    const clone: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string") {
        return fail(path, `unexpected symbol field ${String(key)}`);
      }
      const clonedValue = cloneJsonValue(
        record[key],
        `${path}.${key}`,
        depth + 1,
        seen,
      );
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: clonedValue,
        writable: true,
      });
    }
    return clone;
  } finally {
    seen.delete(value);
  }
}

function expectJsonObject(value: unknown, path: string): JsonObject {
  const record = expectRecord(value, path);
  return cloneJsonValue(record, path, 0, new WeakSet()) as JsonObject;
}

function decodeIdentity(value: unknown, path: string): WorkerIdentity {
  const record = expectRecord(value, path);
  expectExactKeys(record, path, ["workerId", "attemptId", "epoch"]);

  return {
    workerId: expectIdentifier(record.workerId, `${path}.workerId`),
    attemptId: expectIdentifier(record.attemptId, `${path}.attemptId`),
    epoch: expectInteger(record.epoch, `${path}.epoch`, { min: 0 }),
  };
}

function decodeCredential(value: unknown, path: string): WorkerCredential {
  const record = expectRecord(value, path);
  expectExactKeys(record, path, ["kind", "capability"]);

  if (record.kind !== "registration" && record.kind !== "resume") {
    return fail(`${path}.kind`, "expected registration or resume");
  }

  return {
    kind: record.kind,
    capability: expectString(record.capability, `${path}.capability`, {
      maxLength: MAX_CAPABILITY_LENGTH,
    }),
  };
}

function decodeWorkloads(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(path, "expected a non-empty array");
  }

  const workloads = value.map((entry, index) =>
    expectWorkload(entry, `${path}[${index}]`)
  );
  if (new Set(workloads).size !== workloads.length) {
    return fail(path, "workloads must be unique");
  }
  return workloads;
}

function expectFrame(
  value: unknown,
  type: ControlFrame["type"],
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const record = expectRecord(value, "$");
  expectExactKeys(record, "$", ["protocol", "type", ...required], optional);

  if (record.protocol !== WORKER_PROTOCOL) {
    fail(
      "$.protocol",
      `expected ${WORKER_PROTOCOL}`,
      "unsupported_protocol",
    );
  }
  if (record.type !== type) {
    fail("$.type", `expected ${type}`);
  }

  return record;
}

function decodeHello(value: unknown): HelloFrame {
  const record = expectFrame(value, "hello", [
    "handshakeId",
    "identity",
    "credential",
    "workloads",
    "capacity",
  ]);

  return {
    protocol: WORKER_PROTOCOL,
    type: "hello",
    handshakeId: expectIdentifier(record.handshakeId, "$.handshakeId"),
    identity: decodeIdentity(record.identity, "$.identity"),
    credential: decodeCredential(record.credential, "$.credential"),
    workloads: decodeWorkloads(record.workloads, "$.workloads"),
    capacity: expectInteger(record.capacity, "$.capacity", {
      min: 1,
      max: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    }),
  };
}

function decodeWelcome(value: unknown): WelcomeFrame {
  const record = expectFrame(value, "welcome", [
    "connectionId",
    "heartbeatIntervalMs",
    "leaseTimeoutMs",
    "resumeCapability",
    "resumeExpiresAtMs",
    "bootstrap",
  ]);

  const heartbeatIntervalMs = expectInteger(
    record.heartbeatIntervalMs,
    "$.heartbeatIntervalMs",
    { min: 1 },
  );
  const leaseTimeoutMs = expectInteger(
    record.leaseTimeoutMs,
    "$.leaseTimeoutMs",
    { min: 1 },
  );
  if (leaseTimeoutMs <= heartbeatIntervalMs) {
    fail("$.leaseTimeoutMs", "must be greater than heartbeatIntervalMs");
  }

  return {
    protocol: WORKER_PROTOCOL,
    type: "welcome",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
    heartbeatIntervalMs,
    leaseTimeoutMs,
    resumeCapability: expectString(
      record.resumeCapability,
      "$.resumeCapability",
      { maxLength: MAX_CAPABILITY_LENGTH },
    ),
    resumeExpiresAtMs: expectInteger(
      record.resumeExpiresAtMs,
      "$.resumeExpiresAtMs",
      { min: 0 },
    ),
    bootstrap: expectJsonObject(record.bootstrap, "$.bootstrap"),
  };
}

function decodeReady(value: unknown): ReadyFrame {
  const record = expectFrame(value, "ready", [
    "connectionId",
    "capacity",
    "metadata",
  ]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "ready",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
    capacity: expectInteger(record.capacity, "$.capacity", {
      min: 1,
      max: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    }),
    metadata: expectJsonObject(record.metadata, "$.metadata"),
  };
}

function decodeReadyAck(value: unknown): ReadyAckFrame {
  const record = expectFrame(value, "ready_ack", ["connectionId"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "ready_ack",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
  };
}

function decodeHeartbeat(value: unknown): HeartbeatFrame {
  const record = expectFrame(value, "heartbeat", [
    "connectionId",
    "sequence",
    "inflight",
    "availableCapacity",
    "metadata",
  ]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "heartbeat",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
    sequence: expectInteger(record.sequence, "$.sequence", {
      min: 0,
      max: UINT32_MAX,
    }),
    inflight: expectInteger(record.inflight, "$.inflight", {
      min: 0,
      max: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity,
    }),
    availableCapacity: expectInteger(
      record.availableCapacity,
      "$.availableCapacity",
      { min: 0, max: WORKER_PROTOCOL_LIMITS.maxWorkerCapacity },
    ),
    metadata: expectJsonObject(record.metadata, "$.metadata"),
  };
}

function decodeDrained(value: unknown): DrainedFrame {
  const record = expectFrame(value, "drained", ["connectionId"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "drained",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
  };
}

function decodeProtocolError(value: unknown): ProtocolErrorFrame {
  const record = expectFrame(
    value,
    "protocol_error",
    ["code", "message"],
    ["connectionId"],
  );

  const frame: {
    protocol: typeof WORKER_PROTOCOL;
    type: "protocol_error";
    connectionId?: string;
    code: string;
    message: string;
  } = {
    protocol: WORKER_PROTOCOL,
    type: "protocol_error",
    code: expectString(record.code, "$.code", {
      maxLength: MAX_IDENTIFIER_LENGTH,
      pattern: ERROR_CODE_PATTERN,
    }),
    message: expectString(record.message, "$.message", {
      maxLength: MAX_ERROR_MESSAGE_LENGTH,
    }),
  };

  if (Object.hasOwn(record, "connectionId")) {
    frame.connectionId = expectIdentifier(
      record.connectionId,
      "$.connectionId",
    );
  }
  return frame;
}

function decodeDrain(value: unknown): DrainFrame {
  const record = expectFrame(value, "drain", [
    "connectionId",
    "reason",
    "deadlineAtMs",
  ]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "drain",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
    reason: expectString(record.reason, "$.reason", {
      maxLength: MAX_REASON_LENGTH,
    }),
    deadlineAtMs: expectInteger(record.deadlineAtMs, "$.deadlineAtMs", {
      min: 0,
    }),
  };
}

function decodeShutdown(value: unknown): ShutdownFrame {
  const record = expectFrame(value, "shutdown", ["connectionId", "reason"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "shutdown",
    connectionId: expectIdentifier(record.connectionId, "$.connectionId"),
    reason: expectString(record.reason, "$.reason", {
      maxLength: MAX_REASON_LENGTH,
    }),
  };
}

function decodeWorkOpen(value: unknown): WorkOpenFrame {
  const record = expectFrame(
    value,
    "work.open",
    ["streamId", "workload", "metadata"],
    ["deadlineAtMs"],
  );

  const frame: {
    protocol: typeof WORKER_PROTOCOL;
    type: "work.open";
    streamId: string;
    workload: string;
    metadata: JsonObject;
    deadlineAtMs?: number;
  } = {
    protocol: WORKER_PROTOCOL,
    type: "work.open",
    streamId: expectStreamId(record.streamId, "$.streamId"),
    workload: expectWorkload(record.workload, "$.workload"),
    metadata: expectJsonObject(record.metadata, "$.metadata"),
  };

  if (Object.hasOwn(record, "deadlineAtMs")) {
    frame.deadlineAtMs = expectInteger(
      record.deadlineAtMs,
      "$.deadlineAtMs",
      { min: 0 },
    );
  }
  return frame;
}

function decodeWorkAccepted(value: unknown): WorkAcceptedFrame {
  const record = expectFrame(value, "work.accepted", ["streamId"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.accepted",
    streamId: expectStreamId(record.streamId, "$.streamId"),
  };
}

function decodeWorkStart(value: unknown): WorkStartFrame {
  const record = expectFrame(value, "work.start", ["streamId"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.start",
    streamId: expectStreamId(record.streamId, "$.streamId"),
  };
}

function decodeWorkMetadata(value: unknown): WorkMetadataFrame {
  const record = expectFrame(value, "work.metadata", [
    "streamId",
    "metadata",
  ]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.metadata",
    streamId: expectStreamId(record.streamId, "$.streamId"),
    metadata: expectJsonObject(record.metadata, "$.metadata"),
  };
}

function decodeWorkEnd(value: unknown): WorkEndFrame {
  const record = expectFrame(value, "work.end", ["streamId"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.end",
    streamId: expectStreamId(record.streamId, "$.streamId"),
  };
}

function decodeWorkCancel(value: unknown): WorkCancelFrame {
  const record = expectFrame(value, "work.cancel", ["streamId", "reason"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.cancel",
    streamId: expectStreamId(record.streamId, "$.streamId"),
    reason: expectString(record.reason, "$.reason", {
      maxLength: MAX_REASON_LENGTH,
    }),
  };
}

function decodeWorkError(value: unknown): WorkErrorFrame {
  const record = expectFrame(
    value,
    "work.error",
    ["streamId", "code", "message"],
    ["details"],
  );

  const frame: {
    protocol: typeof WORKER_PROTOCOL;
    type: "work.error";
    streamId: string;
    code: string;
    message: string;
    details?: JsonObject;
  } = {
    protocol: WORKER_PROTOCOL,
    type: "work.error",
    streamId: expectStreamId(record.streamId, "$.streamId"),
    code: expectString(record.code, "$.code", {
      maxLength: MAX_IDENTIFIER_LENGTH,
      pattern: ERROR_CODE_PATTERN,
    }),
    message: expectString(record.message, "$.message", {
      maxLength: MAX_ERROR_MESSAGE_LENGTH,
    }),
  };

  if (Object.hasOwn(record, "details")) {
    frame.details = expectJsonObject(record.details, "$.details");
  }
  return frame;
}

function decodeWorkCredit(value: unknown): WorkCreditFrame {
  const record = expectFrame(value, "work.credit", ["streamId", "bytes"]);
  return {
    protocol: WORKER_PROTOCOL,
    type: "work.credit",
    streamId: expectStreamId(record.streamId, "$.streamId"),
    bytes: expectInteger(record.bytes, "$.bytes", {
      min: 1,
      max: WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes,
    }),
  };
}

/**
 * Strictly validates an already-decoded control frame.
 *
 * Unknown fields, invalid nested values and unsupported protocol versions are
 * rejected. A fresh object is returned so caller-owned input cannot mutate the
 * validated frame later.
 */
export function decodeControlFrame(value: unknown): ControlFrame {
  const record = expectRecord(value, "$");
  if (typeof record.type !== "string") {
    return fail("$.type", "expected a string");
  }

  switch (record.type) {
    case "hello":
      return decodeHello(record);
    case "welcome":
      return decodeWelcome(record);
    case "ready":
      return decodeReady(record);
    case "ready_ack":
      return decodeReadyAck(record);
    case "heartbeat":
      return decodeHeartbeat(record);
    case "drain":
      return decodeDrain(record);
    case "shutdown":
      return decodeShutdown(record);
    case "drained":
      return decodeDrained(record);
    case "protocol_error":
      return decodeProtocolError(record);
    case "work.open":
      return decodeWorkOpen(record);
    case "work.accepted":
      return decodeWorkAccepted(record);
    case "work.start":
      return decodeWorkStart(record);
    case "work.metadata":
      return decodeWorkMetadata(record);
    case "work.end":
      return decodeWorkEnd(record);
    case "work.cancel":
      return decodeWorkCancel(record);
    case "work.error":
      return decodeWorkError(record);
    case "work.credit":
      return decodeWorkCredit(record);
    default:
      return fail(
        "$.type",
        `unsupported frame type ${record.type}`,
        "unsupported_frame_type",
      );
  }
}

/** Parses and strictly validates a size-bounded JSON control frame. */
export function parseControlFrame(
  text: string,
  options: ControlFrameCodecOptions = {},
): ControlFrame {
  if (typeof text !== "string") {
    return fail("$", "expected a text frame");
  }
  enforceControlFrameSize(text, options);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("$", "expected valid JSON");
  }
  return decodeControlFrame(value);
}

/**
 * Validates and serializes a control frame.
 *
 * Outbound frames pass through the same strict decoder as inbound frames so
 * internal callers cannot emit an invalid wire message through a type cast.
 */
export function encodeControlFrame(
  frame: ControlFrame,
  options: ControlFrameCodecOptions = {},
): string {
  const encoded = JSON.stringify(decodeControlFrame(frame));
  enforceControlFrameSize(encoded, options);
  return encoded;
}

export function createWorkerIdentity(
  input: WorkerIdentity,
): WorkerIdentity {
  return decodeIdentity(input, "$.identity");
}

export function createHelloFrame(input: FrameInput<HelloFrame>): HelloFrame {
  return decodeHello({
    protocol: WORKER_PROTOCOL,
    type: "hello",
    ...input,
  });
}

export function createWelcomeFrame(
  input:
    & Omit<FrameInput<WelcomeFrame>, "bootstrap">
    & Readonly<{ bootstrap?: JsonObject }>,
): WelcomeFrame {
  return decodeWelcome({
    protocol: WORKER_PROTOCOL,
    type: "welcome",
    bootstrap: {},
    ...input,
  });
}

export function createReadyFrame(
  input:
    & Omit<FrameInput<ReadyFrame>, "metadata">
    & Readonly<{ metadata?: JsonObject }>,
): ReadyFrame {
  return decodeReady({
    protocol: WORKER_PROTOCOL,
    type: "ready",
    metadata: {},
    ...input,
  });
}

export function createReadyAckFrame(
  input: FrameInput<ReadyAckFrame>,
): ReadyAckFrame {
  return decodeReadyAck({
    protocol: WORKER_PROTOCOL,
    type: "ready_ack",
    ...input,
  });
}

export function createHeartbeatFrame(
  input:
    & Omit<FrameInput<HeartbeatFrame>, "metadata">
    & Readonly<{ metadata?: JsonObject }>,
): HeartbeatFrame {
  return decodeHeartbeat({
    protocol: WORKER_PROTOCOL,
    type: "heartbeat",
    metadata: {},
    ...input,
  });
}

export function createDrainFrame(input: FrameInput<DrainFrame>): DrainFrame {
  return decodeDrain({
    protocol: WORKER_PROTOCOL,
    type: "drain",
    ...input,
  });
}

export function createShutdownFrame(
  input: FrameInput<ShutdownFrame>,
): ShutdownFrame {
  return decodeShutdown({
    protocol: WORKER_PROTOCOL,
    type: "shutdown",
    ...input,
  });
}

export function createDrainedFrame(
  input: FrameInput<DrainedFrame>,
): DrainedFrame {
  return decodeDrained({
    protocol: WORKER_PROTOCOL,
    type: "drained",
    ...input,
  });
}

export function createProtocolErrorFrame(
  input: FrameInput<ProtocolErrorFrame>,
): ProtocolErrorFrame {
  return decodeProtocolError({
    protocol: WORKER_PROTOCOL,
    type: "protocol_error",
    ...input,
  });
}

export function createWorkOpenFrame(
  input: FrameInput<WorkOpenFrame>,
): WorkOpenFrame {
  return decodeWorkOpen({
    protocol: WORKER_PROTOCOL,
    type: "work.open",
    ...input,
  });
}

export function createWorkAcceptedFrame(
  input: FrameInput<WorkAcceptedFrame>,
): WorkAcceptedFrame {
  return decodeWorkAccepted({
    protocol: WORKER_PROTOCOL,
    type: "work.accepted",
    ...input,
  });
}

export function createWorkStartFrame(
  input: FrameInput<WorkStartFrame>,
): WorkStartFrame {
  return decodeWorkStart({
    protocol: WORKER_PROTOCOL,
    type: "work.start",
    ...input,
  });
}

export function createWorkMetadataFrame(
  input: FrameInput<WorkMetadataFrame>,
): WorkMetadataFrame {
  return decodeWorkMetadata({
    protocol: WORKER_PROTOCOL,
    type: "work.metadata",
    ...input,
  });
}

export function createWorkEndFrame(
  input: FrameInput<WorkEndFrame>,
): WorkEndFrame {
  return decodeWorkEnd({
    protocol: WORKER_PROTOCOL,
    type: "work.end",
    ...input,
  });
}

export function createWorkCancelFrame(
  input: FrameInput<WorkCancelFrame>,
): WorkCancelFrame {
  return decodeWorkCancel({
    protocol: WORKER_PROTOCOL,
    type: "work.cancel",
    ...input,
  });
}

export function createWorkErrorFrame(
  input: FrameInput<WorkErrorFrame>,
): WorkErrorFrame {
  return decodeWorkError({
    protocol: WORKER_PROTOCOL,
    type: "work.error",
    ...input,
  });
}

export function createWorkCreditFrame(
  input: FrameInput<WorkCreditFrame>,
): WorkCreditFrame {
  return decodeWorkCredit({
    protocol: WORKER_PROTOCOL,
    type: "work.credit",
    ...input,
  });
}
