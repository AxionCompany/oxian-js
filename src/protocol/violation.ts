export type ProtocolViolationCode =
  | "capacity_exceeded"
  | "control_frame_too_large"
  | "credit_exceeded"
  | "data_payload_too_large"
  | "duplicate_stream"
  | "invalid_binary_frame"
  | "invalid_control_frame"
  | "invalid_direction"
  | "invalid_protocol_order"
  | "post_terminal_frame"
  | "sequence_mismatch"
  | "stale_connection"
  | "stream_limit_exceeded"
  | "unknown_stream"
  | "unsupported_frame_type"
  | "unsupported_protocol"
  | "unsupported_workload";

const protocolViolationMarker = Symbol.for(
  "oxian.worker.v1.protocol-violation",
);

export type ProtocolViolation =
  & TypeError
  & Readonly<{
    code: ProtocolViolationCode;
    protocolViolation: true;
  }>;

/**
 * Creates a machine-classifiable protocol error without a custom error class.
 */
export function createProtocolViolation(
  code: ProtocolViolationCode,
  message: string,
): ProtocolViolation {
  const error = new TypeError(message) as unknown as ProtocolViolation;
  Object.defineProperties(error, {
    code: {
      configurable: false,
      enumerable: true,
      value: code,
      writable: false,
    },
    protocolViolation: {
      configurable: false,
      enumerable: true,
      value: true,
      writable: false,
    },
    [protocolViolationMarker]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
  });
  return error;
}

export function isProtocolViolation(
  value: unknown,
): value is ProtocolViolation {
  return value instanceof TypeError &&
    (value as unknown as Record<PropertyKey, unknown>)[
        protocolViolationMarker
      ] === true;
}

export function throwProtocolViolation(
  code: ProtocolViolationCode,
  message: string,
): never {
  throw createProtocolViolation(code, message);
}
