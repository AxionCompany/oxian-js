import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
  type ControlFrame,
  createDrainedFrame,
  createDrainFrame,
  createHeartbeatFrame,
  createHelloFrame,
  createProtocolErrorFrame,
  createReadyAckFrame,
  createReadyFrame,
  createShutdownFrame,
  createWelcomeFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkEndFrame,
  createWorkerIdentity,
  createWorkErrorFrame,
  createWorkMetadataFrame,
  createWorkOpenFrame,
  createWorkStartFrame,
  decodeControlFrame,
  encodeControlFrame,
  parseControlFrame,
  type ProtocolViolation,
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_LIMITS,
} from "../../src/protocol/index.ts";

const STREAM_ID = "018f47a2-76b8-7d31-8c41-1d68b4f9f802";

const IDENTITY = createWorkerIdentity({
  workerId: "api",
  attemptId: "attempt-42",
  epoch: 3,
});

Deno.test("control frames: all v1 frame factories round-trip strictly", () => {
  const frames: ControlFrame[] = [
    createHelloFrame({
      handshakeId: "handshake-1",
      identity: IDENTITY,
      credential: {
        kind: "registration",
        capability: "registration-secret",
      },
      workloads: ["oxian.http.v1", "sandbox.environment.v1"],
      capacity: 8,
    }),
    createWelcomeFrame({
      connectionId: "connection-1",
      heartbeatIntervalMs: 10_000,
      leaseTimeoutMs: 30_000,
      resumeCapability: "resume-secret",
      resumeExpiresAtMs: 2_000_000_000_000,
    }),
    createReadyFrame({
      connectionId: "connection-1",
      capacity: 8,
    }),
    createReadyAckFrame({
      connectionId: "connection-1",
    }),
    createHeartbeatFrame({
      connectionId: "connection-1",
      sequence: 0,
      inflight: 2,
      availableCapacity: 6,
    }),
    createDrainFrame({
      connectionId: "connection-1",
      reason: "deploy",
      deadlineAtMs: 2_000_000_000_000,
    }),
    createDrainedFrame({
      connectionId: "connection-1",
    }),
    createShutdownFrame({
      connectionId: "connection-1",
      reason: "drain complete",
    }),
    createProtocolErrorFrame({
      connectionId: "connection-1",
      code: "unexpected_frame",
      message: "ready was received twice",
    }),
    createWorkOpenFrame({
      streamId: STREAM_ID,
      workload: "oxian.http.v1",
      metadata: {
        method: "POST",
        headers: [["content-type", "application/json"]],
      },
      deadlineAtMs: 2_000_000_000_000,
    }),
    createWorkAcceptedFrame({ streamId: STREAM_ID }),
    createWorkStartFrame({ streamId: STREAM_ID }),
    createWorkMetadataFrame({
      streamId: STREAM_ID,
      metadata: { status: 201 },
    }),
    createWorkEndFrame({ streamId: STREAM_ID }),
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "client disconnected",
    }),
    createWorkErrorFrame({
      streamId: STREAM_ID,
      code: "handler_failed",
      message: "handler rejected",
      details: { status: 500, retryable: false },
    }),
    createWorkCreditFrame({
      streamId: STREAM_ID,
      bytes: 65_536,
    }),
  ];

  for (const frame of frames) {
    assertEquals(parseControlFrame(encodeControlFrame(frame)), frame);
    assertEquals(frame.protocol, WORKER_PROTOCOL);
  }
});

Deno.test("control frames: decoder rejects unknown and missing fields", () => {
  const hello = createHelloFrame({
    handshakeId: "handshake-1",
    identity: IDENTITY,
    credential: { kind: "resume", capability: "resume-secret" },
    workloads: ["oxian.http.v1"],
    capacity: 1,
  });

  assertThrows(
    () => decodeControlFrame({ ...hello, futureField: true }),
    TypeError,
    "unexpected field futureField",
  );

  const { capacity: _, ...withoutCapacity } = hello;
  assertThrows(
    () => decodeControlFrame(withoutCapacity),
    TypeError,
    "missing field capacity",
  );

  assertThrows(
    () =>
      decodeControlFrame({
        ...hello,
        identity: { ...hello.identity, region: "local" },
      }),
    TypeError,
    "unexpected field region",
  );
});

Deno.test("control frames: decoder rejects unsupported protocol and type", () => {
  const ready = createReadyFrame({
    connectionId: "connection-1",
    capacity: 1,
  });

  assertThrows(
    () => decodeControlFrame({ ...ready, protocol: "oxian.worker.v2" }),
    TypeError,
    `expected ${WORKER_PROTOCOL}`,
  );
  assertThrows(
    () =>
      decodeControlFrame({
        protocol: WORKER_PROTOCOL,
        type: "worker.maybe",
      }),
    TypeError,
    "unsupported frame type",
  );
  assertThrows(
    () => parseControlFrame("{"),
    TypeError,
    "expected valid JSON",
  );
});

Deno.test("control frames: parser and encoder enforce UTF-8 byte limits", () => {
  const frame = createProtocolErrorFrame({
    code: "bad_frame",
    message: "💥",
  });
  const encoded = encodeControlFrame(frame);
  const frameBytes = new TextEncoder().encode(encoded).byteLength;

  assertEquals(
    parseControlFrame(encoded, { maxFrameBytes: frameBytes }),
    frame,
  );
  const oversized = assertThrows(
    () => parseControlFrame(encoded, { maxFrameBytes: frameBytes - 1 }),
    TypeError,
    "control frame is",
  );
  assertEquals(
    (oversized as ProtocolViolation).code,
    "control_frame_too_large",
  );
  assertThrows(
    () => encodeControlFrame(frame, { maxFrameBytes: frameBytes - 1 }),
    TypeError,
    "control frame is",
  );
  assertThrows(
    () =>
      parseControlFrame(encoded, {
        maxFrameBytes: WORKER_PROTOCOL_LIMITS.maxControlFrameBytes + 1,
      }),
    TypeError,
    "must not exceed",
  );
  assertThrows(
    () =>
      parseControlFrame(
        JSON.stringify({
          ...frame,
          message: "x".repeat(
            WORKER_PROTOCOL_LIMITS.maxControlFrameBytes,
          ),
        }),
      ),
    TypeError,
    "control frame is",
  );
});

Deno.test("control frames: factories enforce identity and lifecycle bounds", () => {
  assertThrows(
    () =>
      createWorkerIdentity({
        workerId: "contains spaces",
        attemptId: "attempt-1",
        epoch: 0,
      }),
    TypeError,
    "invalid format",
  );
  assertThrows(
    () =>
      createWorkerIdentity({
        workerId: "worker-1",
        attemptId: "attempt-1",
        epoch: -1,
      }),
    TypeError,
    "integer of at least 0",
  );
  assertThrows(
    () =>
      createWelcomeFrame({
        connectionId: "connection-1",
        heartbeatIntervalMs: 30_000,
        leaseTimeoutMs: 30_000,
        resumeCapability: "resume-secret",
        resumeExpiresAtMs: 2_000_000_000_000,
      }),
    TypeError,
    "must be greater than heartbeatIntervalMs",
  );
  assertThrows(
    () =>
      createWelcomeFrame({
        connectionId: "connection-1",
        heartbeatIntervalMs: 10_000,
        leaseTimeoutMs: 30_000,
        resumeCapability: "resume-secret",
        resumeExpiresAtMs: -1,
      }),
    TypeError,
    "integer of at least 0",
  );
  assertThrows(
    () =>
      createHelloFrame({
        handshakeId: "handshake-1",
        identity: IDENTITY,
        credential: {
          kind: "registration",
          capability: "registration-secret",
        },
        workloads: ["oxian.http.v1", "oxian.http.v1"],
        capacity: 1,
      }),
    TypeError,
    "workloads must be unique",
  );
});

Deno.test("control frames: metadata must be JSON and is copied", () => {
  const metadata: Record<string, unknown> = {
    nested: { value: 1 },
    list: [true, null, "value"],
  };
  const frame = createWorkMetadataFrame({
    streamId: STREAM_ID,
    metadata: metadata as never,
  });

  assertNotStrictEquals(frame.metadata, metadata);
  (metadata.nested as Record<string, unknown>).value = 2;
  assertEquals(frame.metadata, {
    nested: { value: 1 },
    list: [true, null, "value"],
  });

  assertThrows(
    () =>
      createWorkMetadataFrame({
        streamId: STREAM_ID,
        metadata: { value: Number.NaN },
      }),
    TypeError,
    "JSON numbers must be finite",
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(
    () =>
      createWorkMetadataFrame({
        streamId: STREAM_ID,
        metadata: cyclic as never,
      }),
    TypeError,
    "must not contain cycles",
  );
});

Deno.test("control frames: heartbeat metadata defaults, copies, and stays bounded", () => {
  const base = {
    connectionId: "connection-1",
    sequence: 0,
    inflight: 0,
    availableCapacity: 1,
  } as const;
  assertEquals(createHeartbeatFrame(base).metadata, {});

  const metadata: Record<string, unknown> = {
    status: { dirty: true },
  };
  const frame = createHeartbeatFrame({
    ...base,
    metadata: metadata as never,
  });
  assertNotStrictEquals(frame.metadata, metadata);
  (metadata.status as Record<string, unknown>).dirty = false;
  assertEquals(frame.metadata, { status: { dirty: true } });

  assertThrows(
    () =>
      createHeartbeatFrame({
        ...base,
        metadata: { progress: Number.NaN },
      }),
    TypeError,
    "JSON numbers must be finite",
  );
  assertThrows(
    () => {
      const { metadata: _, ...withoutMetadata } = frame;
      decodeControlFrame(withoutMetadata);
    },
    TypeError,
    "missing field metadata",
  );

  const oversized = createHeartbeatFrame({
    ...base,
    metadata: {
      status: "x".repeat(WORKER_PROTOCOL_LIMITS.maxControlFrameBytes),
    },
  });
  const error = assertThrows(
    () => encodeControlFrame(oversized),
    TypeError,
    "control frame is",
  );
  assertEquals(
    (error as ProtocolViolation).code,
    "control_frame_too_large",
  );
});

Deno.test("control frames: metadata safely preserves __proto__ as data", () => {
  const metadata = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"plain-data"}',
  );
  const frame = createWorkMetadataFrame({
    streamId: STREAM_ID,
    metadata,
  });

  assertEquals(Object.getPrototypeOf(frame.metadata), Object.prototype);
  assertEquals(Object.hasOwn(frame.metadata, "__proto__"), true);
  assertEquals(frame.metadata, {
    ["__proto__"]: { polluted: true },
    constructor: "plain-data",
  });
  assertEquals(({} as Record<string, unknown>).polluted, undefined);
});
