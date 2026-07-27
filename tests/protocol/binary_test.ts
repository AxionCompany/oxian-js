import {
  assertEquals,
  assertMatch,
  assertNotStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  BINARY_PROTOCOL,
  createStreamId,
  createWorkDataFrame,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ProtocolViolation,
  validateWorkDataFrame,
  WORKER_PROTOCOL_LIMITS,
} from "../../src/protocol/index.ts";

const STREAM_ID = "018f47a2-76b8-7d31-8c41-1d68b4f9f802";

Deno.test("binary frames: work.data round-trips stream, sequence and bytes", () => {
  const payload = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const frame = createWorkDataFrame({
    streamId: STREAM_ID,
    sequence: 4_294_967_295,
    payload,
  });
  const encoded = encodeBinaryFrame(frame);
  const decoded = decodeBinaryFrame(encoded);

  assertEquals(decoded, frame);
  assertNotStrictEquals(
    decoded.payload,
    encoded.subarray(BINARY_PROTOCOL.headerBytes),
  );
  assertEquals(
    encoded.byteLength,
    BINARY_PROTOCOL.headerBytes + payload.length,
  );
  assertEquals(Array.from(encoded.subarray(0, 4)), [0x4f, 0x58, 0x4e, 0x42]);
  assertEquals(encoded[4], BINARY_PROTOCOL.version);
  assertEquals(encoded[5], BINARY_PROTOCOL.workDataType);
});

Deno.test("binary frames: decoder respects a Uint8Array view offset", () => {
  const encoded = encodeBinaryFrame(
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 7,
      payload: new Uint8Array([10, 20, 30]),
    }),
  );
  const storage = new Uint8Array(encoded.length + 10);
  storage.set(encoded, 5);

  assertEquals(
    decodeBinaryFrame(storage.subarray(5, 5 + encoded.length)),
    {
      type: "work.data",
      streamId: STREAM_ID,
      sequence: 7,
      payload: new Uint8Array([10, 20, 30]),
    },
  );
});

Deno.test("binary frames: frame factory owns a copy of caller payload", () => {
  const payload = new Uint8Array([1, 2, 3]);
  const frame = createWorkDataFrame({
    streamId: STREAM_ID,
    sequence: 0,
    payload,
  });

  payload[0] = 99;
  assertEquals(frame.payload, new Uint8Array([1, 2, 3]));
});

Deno.test("binary frames: decoder enforces header and receive limit", () => {
  const encoded = encodeBinaryFrame(
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([1, 2, 3]),
    }),
  );

  const wrongMagic = encoded.slice();
  wrongMagic[0] = 0;
  assertThrows(
    () => decodeBinaryFrame(wrongMagic),
    TypeError,
    "magic does not match",
  );

  const wrongVersion = encoded.slice();
  wrongVersion[4] = 2;
  assertThrows(
    () => decodeBinaryFrame(wrongVersion),
    TypeError,
    "unsupported version 2",
  );

  const wrongType = encoded.slice();
  wrongType[5] = 99;
  assertThrows(
    () => decodeBinaryFrame(wrongType),
    TypeError,
    "unsupported frame type 99",
  );

  const reserved = encoded.slice();
  reserved[7] = 1;
  assertThrows(
    () => decodeBinaryFrame(reserved),
    TypeError,
    "reserved header bytes",
  );

  assertThrows(
    () => decodeBinaryFrame(encoded, { maxPayloadBytes: 2 }),
    TypeError,
    "payload exceeds",
  );
  assertThrows(
    () => decodeBinaryFrame(new Uint8Array(27)),
    TypeError,
    "shorter than 28 bytes",
  );
});

Deno.test("binary frames: factory rejects invalid stream and sequence", () => {
  assertThrows(
    () =>
      createWorkDataFrame({
        streamId: "not-a-uuid",
        sequence: 0,
        payload: new Uint8Array(),
      }),
    TypeError,
    "lowercase UUID",
  );
  assertThrows(
    () =>
      createWorkDataFrame({
        streamId: STREAM_ID,
        sequence: 4_294_967_296,
        payload: new Uint8Array(),
      }),
    TypeError,
    "sequence must be",
  );

  assertMatch(
    createStreamId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

Deno.test("binary frames: runtime validator rejects malformed and empty data", () => {
  const malformed = assertThrows(
    () =>
      validateWorkDataFrame({
        type: "not.work.data",
        streamId: STREAM_ID,
        sequence: 0,
        payload: { byteLength: 1 },
      }),
    TypeError,
    "unsupported frame type",
  );
  assertEquals(
    (malformed as ProtocolViolation).code,
    "unsupported_frame_type",
  );

  assertThrows(
    () =>
      validateWorkDataFrame({
        type: "work.data",
        streamId: STREAM_ID,
        sequence: 0,
        payload: new Uint8Array(),
      }),
    TypeError,
    "must not be empty",
  );
  assertThrows(
    () =>
      validateWorkDataFrame({
        type: "work.data",
        streamId: STREAM_ID,
        sequence: 0,
        payload: new Uint8Array([1]),
        extra: true,
      }),
    TypeError,
    "exactly",
  );
});

Deno.test("binary frames: v1 hard payload limit cannot be raised", () => {
  assertEquals(
    BINARY_PROTOCOL.maxPayloadBytes,
    WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes,
  );
  assertThrows(
    () =>
      decodeBinaryFrame(new Uint8Array(28), {
        maxPayloadBytes: WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes + 1,
      }),
    TypeError,
    "must not exceed",
  );
});
