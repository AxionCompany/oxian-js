import { WORKER_PROTOCOL_LIMITS } from "./limits.ts";
import type { WorkDataFrame } from "./types.ts";
import {
  type ProtocolViolationCode,
  throwProtocolViolation,
} from "./violation.ts";

const BINARY_MAGIC = new Uint8Array([0x4f, 0x58, 0x4e, 0x42]); // OXNB
const BINARY_VERSION = 1;
const WORK_DATA_TYPE = 1;
const BINARY_HEADER_BYTES = 28;
const UINT32_MAX = 0xffff_ffff;
const STREAM_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BinaryFrameOptions = Readonly<{
  maxPayloadBytes?: number;
}>;

function fail(
  message: string,
  code: ProtocolViolationCode = "invalid_binary_frame",
): never {
  return throwProtocolViolation(
    code,
    `Invalid Oxian binary frame: ${message}`,
  );
}

function expectPayloadLimit(options: BinaryFrameOptions): number {
  const limit = options.maxPayloadBytes ??
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new TypeError("maxPayloadBytes must be a positive safe integer");
  }
  if (limit > WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes) {
    throw new TypeError(
      `maxPayloadBytes must not exceed the oxian.worker.v1 limit of ${WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes}`,
    );
  }
  return limit;
}

function validateStreamId(streamId: unknown): string {
  if (typeof streamId !== "string" || !STREAM_ID_PATTERN.test(streamId)) {
    return fail("streamId must be a lowercase UUID");
  }
  return streamId;
}

function validateSequence(sequence: unknown): number {
  if (
    typeof sequence !== "number" ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    sequence > UINT32_MAX
  ) {
    return fail(`sequence must be an integer between 0 and ${UINT32_MAX}`);
  }
  return sequence;
}

function validatePayload(
  payload: unknown,
  maxPayloadBytes: number,
): Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    return fail("payload must be a Uint8Array");
  }
  if (payload.byteLength === 0) {
    return fail("payload must not be empty");
  }
  if (payload.byteLength > maxPayloadBytes) {
    return fail(
      `payload exceeds the ${maxPayloadBytes} byte limit`,
      "data_payload_too_large",
    );
  }
  return payload;
}

function streamIdToBytes(streamId: string): Uint8Array {
  const compact = validateStreamId(streamId).replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToStreamId(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Creates a protocol stream ID suitable for control and binary frames. */
export function createStreamId(): string {
  return crypto.randomUUID();
}

/**
 * Strictly validates a decoded work-data object without copying its payload.
 */
export function validateWorkDataFrame(
  value: unknown,
  options: BinaryFrameOptions = {},
): WorkDataFrame {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected a work.data object");
  }
  const record = value as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(record);
  const expectedKeys = new Set(["type", "streamId", "sequence", "payload"]);
  if (
    keys.length !== expectedKeys.size ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) {
    return fail(
      "work.data must contain exactly type, streamId, sequence, payload",
    );
  }
  if (record.type !== "work.data") {
    return fail("unsupported frame type", "unsupported_frame_type");
  }

  const maxPayloadBytes = expectPayloadLimit(options);
  return {
    type: "work.data",
    streamId: validateStreamId(record.streamId),
    sequence: validateSequence(record.sequence),
    payload: validatePayload(record.payload, maxPayloadBytes),
  };
}

/**
 * Creates a work-data frame that owns a copy of the caller's payload.
 */
export function createWorkDataFrame(
  input: Omit<WorkDataFrame, "type">,
  options: BinaryFrameOptions = {},
): WorkDataFrame {
  const validated = validateWorkDataFrame({
    type: "work.data",
    ...input,
  }, options);
  return {
    ...validated,
    payload: validated.payload.slice(),
  };
}

/**
 * Encodes a data frame using a fixed 28-byte header:
 *
 * - bytes 0..3: `OXNB` magic
 * - byte 4: binary protocol version
 * - byte 5: frame type (`1` = `work.data`)
 * - bytes 6..7: reserved, zero
 * - bytes 8..23: UUID stream ID
 * - bytes 24..27: unsigned sequence number, big endian
 * - remaining bytes: opaque payload
 */
export function encodeBinaryFrame(
  input: WorkDataFrame,
  options: BinaryFrameOptions = {},
): Uint8Array {
  const frame = validateWorkDataFrame(input, options);
  const streamId = streamIdToBytes(frame.streamId);
  const encoded = new Uint8Array(
    BINARY_HEADER_BYTES + frame.payload.byteLength,
  );

  encoded.set(BINARY_MAGIC, 0);
  encoded[4] = BINARY_VERSION;
  encoded[5] = WORK_DATA_TYPE;
  encoded[6] = 0;
  encoded[7] = 0;
  encoded.set(streamId, 8);
  new DataView(encoded.buffer).setUint32(24, frame.sequence, false);
  encoded.set(frame.payload, BINARY_HEADER_BYTES);

  return encoded;
}

/**
 * Strictly decodes a size-bounded binary data frame.
 *
 * The returned payload is detached from the input view. This makes it safe for
 * WebSocket adapters that recycle or transfer their receive buffers.
 */
export function decodeBinaryFrame(
  input: ArrayBuffer | Uint8Array,
  options: BinaryFrameOptions = {},
): WorkDataFrame {
  const maxPayloadBytes = expectPayloadLimit(options);
  const encoded = input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);

  if (encoded.byteLength < BINARY_HEADER_BYTES) {
    return fail(`frame is shorter than ${BINARY_HEADER_BYTES} bytes`);
  }

  for (let index = 0; index < BINARY_MAGIC.length; index++) {
    if (encoded[index] !== BINARY_MAGIC[index]) {
      return fail("magic does not match OXNB");
    }
  }
  if (encoded[4] !== BINARY_VERSION) {
    return fail(
      `unsupported version ${encoded[4]}`,
      "unsupported_protocol",
    );
  }
  if (encoded[5] !== WORK_DATA_TYPE) {
    return fail(
      `unsupported frame type ${encoded[5]}`,
      "unsupported_frame_type",
    );
  }
  if (encoded[6] !== 0 || encoded[7] !== 0) {
    return fail("reserved header bytes must be zero");
  }

  const payloadBytes = encoded.byteLength - BINARY_HEADER_BYTES;
  if (payloadBytes === 0) {
    return fail("payload must not be empty");
  }
  if (payloadBytes > maxPayloadBytes) {
    return fail(
      `payload exceeds the ${maxPayloadBytes} byte receive limit`,
      "data_payload_too_large",
    );
  }

  const dataView = new DataView(
    encoded.buffer,
    encoded.byteOffset,
    encoded.byteLength,
  );
  return {
    type: "work.data",
    streamId: bytesToStreamId(encoded.subarray(8, 24)),
    sequence: dataView.getUint32(24, false),
    payload: encoded.subarray(BINARY_HEADER_BYTES).slice(),
  };
}

export type BinaryProtocol = Readonly<{
  version: number;
  headerBytes: number;
  workDataType: number;
  maxPayloadBytes: number;
}>;

export const BINARY_PROTOCOL: BinaryProtocol = Object.freeze({
  version: BINARY_VERSION,
  headerBytes: BINARY_HEADER_BYTES,
  workDataType: WORK_DATA_TYPE,
  maxPayloadBytes: WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
});
