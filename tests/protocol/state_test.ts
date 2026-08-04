import { assertEquals, assertThrows } from "@std/assert";
import {
  createDrainedFrame,
  createDrainFrame,
  createHeartbeatFrame,
  createHelloFrame,
  createProtocolErrorFrame,
  createProtocolOrderValidator,
  createReadyAckFrame,
  createReadyFrame,
  createShutdownFrame,
  createWelcomeFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkDataFrame,
  createWorkEndFrame,
  createWorkErrorFrame,
  createWorkMetadataFrame,
  createWorkOpenFrame,
  createWorkStartFrame,
  type ProtocolDirection,
  type ProtocolOrderValidator,
  type ProtocolOrderValidatorOptions,
  type ProtocolRole,
  type ProtocolViolation,
  WORKER_PROTOCOL_LIMITS,
} from "../../src/protocol/index.ts";

const CONNECTION_ID = "connection-1";
const STREAM_ID = "018f47a2-76b8-7d31-8c41-1d68b4f9f802";
const OTHER_STREAM_ID = "018f47a2-76b8-7d31-8c41-1d68b4f9f803";
const THIRD_STREAM_ID = "018f47a2-76b8-7d31-8c41-1d68b4f9f804";

const HELLO = createHelloFrame({
  handshakeId: "handshake-1",
  identity: {
    workerId: "api",
    attemptId: "attempt-1",
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: "registration-secret",
  },
  workloads: ["oxian.http.v1"],
  capacity: 2,
});

const WELCOME = createWelcomeFrame({
  connectionId: CONNECTION_ID,
  heartbeatIntervalMs: 10_000,
  leaseTimeoutMs: 30_000,
  resumeCapability: "resume-secret",
  resumeExpiresAtMs: 2_000_000_000_000,
});

const READY = createReadyFrame({
  connectionId: CONNECTION_ID,
  capacity: 2,
});

const READY_ACK = createReadyAckFrame({
  connectionId: CONNECTION_ID,
});

function direction(
  role: ProtocolRole,
  sender: ProtocolRole,
): ProtocolDirection {
  return role === sender ? "sent" : "received";
}

function createReadyValidator(
  role: ProtocolRole = "worker",
  overrides: Omit<ProtocolOrderValidatorOptions, "role"> = {},
): ProtocolOrderValidator {
  const validator = createProtocolOrderValidator({ role, ...overrides });
  validator.acceptControl(direction(role, "worker"), HELLO);
  validator.acceptControl(direction(role, "hypervisor"), WELCOME);
  validator.acceptControl(direction(role, "worker"), READY);
  validator.acceptControl(direction(role, "hypervisor"), READY_ACK);
  return validator;
}

function openAndAccept(
  validator: ProtocolOrderValidator,
  role: ProtocolRole = "worker",
  streamId = STREAM_ID,
): void {
  validator.acceptControl(
    direction(role, "hypervisor"),
    createWorkOpenFrame({
      streamId,
      workload: "oxian.http.v1",
      metadata: { method: "POST" },
    }),
  );
  validator.acceptControl(
    direction(role, "worker"),
    createWorkAcceptedFrame({ streamId }),
  );
}

function startStream(
  validator: ProtocolOrderValidator,
  role: ProtocolRole = "worker",
  streamId = STREAM_ID,
): void {
  validator.acceptControl(
    direction(role, "hypervisor"),
    createWorkStartFrame({ streamId }),
  );
}

function openAcceptStart(
  validator: ProtocolOrderValidator,
  role: ProtocolRole = "worker",
  streamId = STREAM_ID,
  sendWorkerMetadata = true,
): void {
  openAndAccept(validator, role, streamId);
  startStream(validator, role, streamId);
  if (sendWorkerMetadata) {
    validator.acceptControl(
      direction(role, "worker"),
      createWorkMetadataFrame({ streamId, metadata: {} }),
    );
  }
}

function closeNormally(
  validator: ProtocolOrderValidator,
  role: ProtocolRole,
  streamId: string,
): void {
  validator.acceptControl(
    direction(role, "worker"),
    createWorkEndFrame({ streamId }),
  );
  validator.acceptControl(
    direction(role, "hypervisor"),
    createWorkEndFrame({ streamId }),
  );
}

Deno.test("protocol order: validates both sides of the handshake", () => {
  for (const role of ["worker", "hypervisor"] as const) {
    const validator = createReadyValidator(role);
    assertEquals(validator.snapshot(), {
      role,
      phase: "ready",
      identity: HELLO.identity,
      workloads: ["oxian.http.v1"],
      connectionId: CONNECTION_ID,
      capacity: 2,
      nextHeartbeatSequence: 0,
      activeStreamCount: 0,
      usedStreamCount: 0,
      maxLifetimeStreams: WORKER_PROTOCOL_LIMITS.maxLifetimeStreams,
      streams: [],
    });
  }
});

Deno.test("protocol order: Ready is not working state before Hypervisor acknowledgement", () => {
  for (const role of ["worker", "hypervisor"] as const) {
    const validator = createProtocolOrderValidator({ role });
    validator.acceptControl(direction(role, "worker"), HELLO);
    validator.acceptControl(direction(role, "hypervisor"), WELCOME);
    validator.acceptControl(direction(role, "worker"), READY);
    assertEquals(validator.snapshot().phase, "readied");

    assertThrows(
      () =>
        validator.acceptControl(
          direction(role, "worker"),
          createHeartbeatFrame({
            connectionId: CONNECTION_ID,
            sequence: 0,
            inflight: 0,
            availableCapacity: 2,
          }),
        ),
      TypeError,
      "not allowed while connection is readied",
    );
    assertThrows(
      () =>
        validator.acceptControl(
          direction(role, "hypervisor"),
          createReadyAckFrame({ connectionId: "connection-stale" }),
        ),
      TypeError,
      "uses stale connection",
    );
    validator.acceptControl(direction(role, "hypervisor"), READY_ACK);
    assertEquals(validator.snapshot().phase, "ready");
  }
});

Deno.test("protocol order: rejects wrong-direction and stale lifecycle frames", () => {
  const worker = createProtocolOrderValidator({ role: "worker" });
  assertThrows(
    () => worker.acceptControl("received", HELLO),
    TypeError,
    "hello can only be sent by a worker",
  );

  worker.acceptControl("sent", HELLO);
  assertThrows(
    () => worker.acceptControl("sent", WELCOME),
    TypeError,
    "welcome can only be sent by a hypervisor",
  );
  worker.acceptControl("received", WELCOME);
  assertThrows(
    () =>
      worker.acceptControl(
        "sent",
        createReadyFrame({ connectionId: "connection-old", capacity: 2 }),
      ),
    TypeError,
    "uses stale connection",
  );
  assertThrows(
    () =>
      worker.acceptControl(
        "sent",
        createReadyFrame({ connectionId: CONNECTION_ID, capacity: 1 }),
      ),
    TypeError,
    "differs from hello capacity",
  );
});

Deno.test("protocol order: heartbeat sequence and load remain bounded", () => {
  const validator = createReadyValidator();
  const accepted = validator.acceptControl(
    "sent",
    createHeartbeatFrame({
      connectionId: CONNECTION_ID,
      sequence: 0,
      inflight: 1,
      availableCapacity: 1,
      metadata: { processes: { active: 1 } },
    }),
  );
  assertEquals(
    accepted.frame.type === "heartbeat" ? accepted.frame.metadata : undefined,
    { processes: { active: 1 } },
  );
  assertEquals(validator.snapshot().nextHeartbeatSequence, 1);

  const sequenceGap = assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createHeartbeatFrame({
          connectionId: CONNECTION_ID,
          sequence: 2,
          inflight: 1,
          availableCapacity: 1,
        }),
      ),
    TypeError,
    "does not match expected 1",
  );
  assertEquals(
    (sequenceGap as ProtocolViolation).code,
    "sequence_mismatch",
  );

  assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createHeartbeatFrame({
          connectionId: CONNECTION_ID,
          sequence: 1,
          inflight: 2,
          availableCapacity: 1,
        }),
      ),
    TypeError,
    "exceeds the declared worker capacity",
  );
  assertEquals(validator.snapshot().nextHeartbeatSequence, 1);

  validator.acceptControl(
    "sent",
    createHeartbeatFrame({
      connectionId: CONNECTION_ID,
      sequence: 1,
      inflight: 0,
      availableCapacity: 2,
    }),
  );
  assertEquals(validator.snapshot().nextHeartbeatSequence, 2);
});

Deno.test("protocol order: accepted reserves and start authorizes execution", () => {
  const validator = createReadyValidator();
  validator.acceptControl(
    "received",
    createWorkOpenFrame({
      streamId: STREAM_ID,
      workload: "oxian.http.v1",
      metadata: {},
    }),
  );
  const data = createWorkDataFrame({
    streamId: STREAM_ID,
    sequence: 0,
    payload: new Uint8Array([1]),
  });

  assertThrows(
    () => validator.acceptBinary("sent", data),
    TypeError,
    "precedes work.start",
  );
  assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkStartFrame({ streamId: STREAM_ID }),
      ),
    TypeError,
    "precedes acceptance",
  );

  validator.acceptControl(
    "sent",
    createWorkAcceptedFrame({ streamId: STREAM_ID }),
  );
  assertEquals(validator.snapshot().streams[0].status, "accepted");
  assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
      ),
    TypeError,
    "precedes work.start",
  );

  const start = validator.acceptControl(
    "received",
    createWorkStartFrame({ streamId: STREAM_ID }),
  );
  assertEquals(start.disposition, "deliver");
  assertEquals(validator.snapshot().streams[0].status, "started");
  assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkStartFrame({ streamId: STREAM_ID }),
      ),
    TypeError,
    "already started",
  );
  validator.acceptControl(
    "sent",
    createWorkMetadataFrame({ streamId: STREAM_ID, metadata: {} }),
  );

  assertThrows(
    () => validator.acceptBinary("sent", data),
    TypeError,
    "insufficient stream credit",
  );
  validator.acceptControl(
    "received",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
  );
  validator.acceptBinary("sent", data);
  assertEquals(validator.snapshot().streams[0].sendCredit, 0);
});

Deno.test("protocol order: interleaves bidirectional stream sequences independently", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator, "worker", STREAM_ID);
  openAcceptStart(validator, "worker", OTHER_STREAM_ID);

  for (const streamId of [STREAM_ID, OTHER_STREAM_ID]) {
    validator.acceptControl(
      "received",
      createWorkCreditFrame({ streamId, bytes: 2 }),
    );
    validator.acceptControl(
      "sent",
      createWorkCreditFrame({ streamId, bytes: 2 }),
    );
  }

  validator.acceptBinary(
    "sent",
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([1]),
    }),
  );
  validator.acceptBinary(
    "received",
    createWorkDataFrame({
      streamId: OTHER_STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([2]),
    }),
  );
  validator.acceptBinary(
    "sent",
    createWorkDataFrame({
      streamId: OTHER_STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([3]),
    }),
  );
  validator.acceptBinary(
    "received",
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([4]),
    }),
  );
  validator.acceptBinary(
    "sent",
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 1,
      payload: new Uint8Array([5]),
    }),
  );

  assertEquals(
    validator.snapshot().streams.map((stream) => ({
      streamId: stream.streamId,
      sent: stream.nextSentSequence,
      received: stream.nextReceivedSequence,
      sendCredit: stream.sendCredit,
      receiveCredit: stream.receiveCredit,
    })),
    [
      {
        streamId: STREAM_ID,
        sent: 2,
        received: 1,
        sendCredit: 0,
        receiveCredit: 1,
      },
      {
        streamId: OTHER_STREAM_ID,
        sent: 1,
        received: 1,
        sendCredit: 1,
        receiveCredit: 1,
      },
    ],
  );
});

Deno.test("protocol order: validates runtime binary objects before state mutation", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator);
  validator.acceptControl(
    "received",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
  );

  const malformed = assertThrows(
    () =>
      validator.acceptBinary("sent", {
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
  assertEquals(validator.snapshot().streams[0].nextSentSequence, 0);
  assertEquals(validator.snapshot().streams[0].sendCredit, 1);
});

Deno.test("protocol order: fixed credit limits agree across stricter receivers", () => {
  const worker = createReadyValidator("worker", {
    maxReceiveCreditBytes: 5,
  });
  const hypervisor = createReadyValidator("hypervisor", {
    maxReceiveCreditBytes: 3,
  });
  openAcceptStart(worker, "worker");
  openAcceptStart(hypervisor, "hypervisor");

  const workerGrant = createWorkCreditFrame({
    streamId: STREAM_ID,
    bytes: 4,
  });
  worker.acceptControl("sent", workerGrant);
  hypervisor.acceptControl("received", workerGrant);

  const hypervisorGrant = createWorkCreditFrame({
    streamId: STREAM_ID,
    bytes: 4,
  });
  assertThrows(
    () => hypervisor.acceptControl("sent", hypervisorGrant),
    TypeError,
    "would exceed",
  );

  assertThrows(
    () =>
      createProtocolOrderValidator({
        role: "worker",
        maxReceiveCreditBytes:
          WORKER_PROTOCOL_LIMITS.maxOutstandingStreamCreditBytes + 1,
      }),
    TypeError,
    "must not exceed",
  );
  assertThrows(
    () =>
      createProtocolOrderValidator({
        role: "worker",
        maxDataPayloadBytes: WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes + 1,
      }),
    TypeError,
    "must not exceed",
  );
});

Deno.test("protocol order: enforces workload declaration and active capacity", () => {
  const validator = createReadyValidator();
  const unsupported = assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkOpenFrame({
          streamId: STREAM_ID,
          workload: "unknown.v1",
          metadata: {},
        }),
      ),
    TypeError,
    "did not declare workload",
  );
  assertEquals(
    (unsupported as ProtocolViolation).code,
    "unsupported_workload",
  );

  openAndAccept(validator, "worker", STREAM_ID);
  openAndAccept(validator, "worker", OTHER_STREAM_ID);
  assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkOpenFrame({
          streamId: THIRD_STREAM_ID,
          workload: "oxian.http.v1",
          metadata: {},
        }),
      ),
    TypeError,
    "no available stream capacity",
  );
});

Deno.test("protocol order: binary sequences reject gaps in either direction", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator);
  validator.acceptControl(
    "sent",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 2 }),
  );

  assertThrows(
    () =>
      validator.acceptBinary(
        "received",
        createWorkDataFrame({
          streamId: STREAM_ID,
          sequence: 1,
          payload: new Uint8Array([1]),
        }),
      ),
    TypeError,
    "does not match expected 0",
  );
});

Deno.test("protocol order: crossed cancel and acceptance preserve boundary", () => {
  const validator = createReadyValidator("hypervisor");
  validator.acceptControl(
    "sent",
    createWorkOpenFrame({
      streamId: STREAM_ID,
      workload: "oxian.http.v1",
      metadata: {},
    }),
  );
  validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "caller disconnected",
    }),
  );

  const crossedAcceptance = validator.acceptControl(
    "received",
    createWorkAcceptedFrame({ streamId: STREAM_ID }),
  );
  assertEquals(crossedAcceptance.disposition, "deliver");
  assertEquals(validator.snapshot().streams[0], {
    streamId: STREAM_ID,
    status: "terminating",
    accepted: true,
    started: false,
    sentTerminal: "cancel",
    nextSentSequence: 0,
    nextReceivedSequence: 0,
    sendCredit: 0,
    receiveCredit: 0,
  });

  const acknowledgement = validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "cancel acknowledged",
    }),
  );
  assertEquals(acknowledgement.disposition, "discard");
  assertEquals(validator.snapshot().activeStreamCount, 0);
  assertEquals(validator.snapshot().usedStreamCount, 1);
});

Deno.test("protocol order: worker detects cancellation queued before acceptance", () => {
  const validator = createReadyValidator("worker");
  validator.acceptControl(
    "received",
    createWorkOpenFrame({
      streamId: STREAM_ID,
      workload: "oxian.http.v1",
      metadata: {},
    }),
  );
  validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "caller disconnected before acceptance",
    }),
  );

  const violation = assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createWorkAcceptedFrame({ streamId: STREAM_ID }),
      ),
    TypeError,
    "aborted",
  );
  assertEquals(
    (violation as ProtocolViolation).code,
    "post_terminal_frame",
  );
  assertEquals(validator.snapshot().activeStreamCount, 1);

  const acknowledgement = validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "cancel acknowledged",
    }),
  );
  assertEquals(acknowledgement.disposition, "deliver");
  assertEquals(validator.snapshot().activeStreamCount, 0);
});

Deno.test("protocol order: crossed data is validated then discarded after cancel", () => {
  const validator = createReadyValidator("hypervisor");
  openAcceptStart(validator, "hypervisor");
  validator.acceptControl(
    "sent",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 2 }),
  );
  validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "caller disconnected",
    }),
  );

  const crossedData = validator.acceptBinary(
    "received",
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([1]),
    }),
  );
  assertEquals(crossedData.disposition, "discard");
  assertEquals(validator.snapshot().streams[0].nextReceivedSequence, 1);
  assertEquals(validator.snapshot().streams[0].receiveCredit, 1);

  validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "cancel acknowledged",
    }),
  );
  assertEquals(validator.snapshot().activeStreamCount, 0);
});

Deno.test("protocol order: crossed start and data are discarded after local error", () => {
  const beforeStart = createReadyValidator("worker");
  openAndAccept(beforeStart);
  beforeStart.acceptControl(
    "sent",
    createWorkErrorFrame({
      streamId: STREAM_ID,
      code: "worker_unavailable",
      message: "worker is stopping",
    }),
  );
  const crossedStart = beforeStart.acceptControl(
    "received",
    createWorkStartFrame({ streamId: STREAM_ID }),
  );
  assertEquals(crossedStart.disposition, "discard");
  assertEquals(beforeStart.snapshot().streams[0].started, true);
  beforeStart.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "error acknowledged",
    }),
  );
  assertEquals(beforeStart.snapshot().activeStreamCount, 0);

  const afterStart = createReadyValidator("worker");
  openAcceptStart(afterStart);
  afterStart.acceptControl(
    "sent",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
  );
  afterStart.acceptControl(
    "sent",
    createWorkErrorFrame({
      streamId: STREAM_ID,
      code: "handler_failed",
      message: "handler failed",
    }),
  );
  const crossedData = afterStart.acceptBinary(
    "received",
    createWorkDataFrame({
      streamId: STREAM_ID,
      sequence: 0,
      payload: new Uint8Array([1]),
    }),
  );
  assertEquals(crossedData.disposition, "discard");
});

Deno.test("protocol order: same-direction frames after terminal are rejected", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator);
  validator.acceptControl(
    "sent",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
  );
  validator.acceptControl(
    "received",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );

  const violation = assertThrows(
    () =>
      validator.acceptBinary(
        "received",
        createWorkDataFrame({
          streamId: STREAM_ID,
          sequence: 0,
          payload: new Uint8Array([1]),
        }),
      ),
    TypeError,
    "same stream half",
  );
  assertEquals(
    (violation as ProtocolViolation).code,
    "post_terminal_frame",
  );
  assertEquals(validator.snapshot().activeStreamCount, 1);

  validator.acceptControl(
    "sent",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );
  assertEquals(validator.snapshot().activeStreamCount, 0);
});

Deno.test("protocol order: a normal End may be upgraded once to whole-stream Cancel", () => {
  const validator = createReadyValidator("hypervisor");
  openAcceptStart(validator, "hypervisor");
  validator.acceptControl(
    "sent",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );
  assertEquals(validator.snapshot().streams[0].sentTerminal, "end");

  validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "response consumer abandoned output",
    }),
  );
  assertEquals(validator.snapshot().streams[0].sentTerminal, "cancel");
  assertEquals(validator.snapshot().streams[0].status, "terminating");

  const duplicate = assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createWorkCancelFrame({
          streamId: STREAM_ID,
          reason: "duplicate cancellation",
        }),
      ),
    TypeError,
    "follows a terminal frame",
  );
  assertEquals(
    (duplicate as ProtocolViolation).code,
    "post_terminal_frame",
  );

  const acknowledgement = validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "cancel acknowledged",
    }),
  );
  assertEquals(acknowledgement.disposition, "discard");
  assertEquals(validator.snapshot().activeStreamCount, 0);
});

Deno.test("protocol order: mixed End and Abort stays active until reciprocal upgrade", () => {
  const validator = createReadyValidator("hypervisor");
  openAcceptStart(validator, "hypervisor");
  validator.acceptControl(
    "sent",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );
  validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "worker aborted after request end",
    }),
  );

  assertEquals(validator.snapshot().activeStreamCount, 1);
  assertEquals(validator.snapshot().streams[0].sentTerminal, "end");
  assertEquals(validator.snapshot().streams[0].receivedTerminal, "cancel");

  validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "abort acknowledged",
    }),
  );
  assertEquals(validator.snapshot().activeStreamCount, 0);
});

Deno.test("protocol order: normal terminal tombstone reciprocates a late abort upgrade", () => {
  const validator = createReadyValidator("hypervisor");
  openAcceptStart(validator, "hypervisor");
  validator.acceptControl(
    "sent",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );
  validator.acceptControl(
    "received",
    createWorkEndFrame({ streamId: STREAM_ID }),
  );
  assertEquals(validator.snapshot().activeStreamCount, 0);

  const lateUpgrade = validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "late crossed cancellation",
    }),
  );
  assertEquals(lateUpgrade.disposition, "discard");
  assertEquals(validator.snapshot().activeStreamCount, 0);

  const acknowledgement = validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "late abort acknowledged",
    }),
  );
  assertEquals(acknowledgement.disposition, "discard");
  assertEquals(validator.snapshot().activeStreamCount, 0);

  const duplicate = assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkCancelFrame({
          streamId: STREAM_ID,
          reason: "duplicate late cancellation",
        }),
      ),
    TypeError,
    "terminal stream",
  );
  assertEquals(
    (duplicate as ProtocolViolation).code,
    "post_terminal_frame",
  );
});

Deno.test("protocol order: End/End tombstones discard crossed inbound credit", () => {
  for (const role of ["worker", "hypervisor"] as const) {
    const validator = createReadyValidator(role);
    openAcceptStart(validator, role);
    closeNormally(validator, role, STREAM_ID);
    assertEquals(validator.snapshot().activeStreamCount, 0);

    // The peer granted this credit before receiving our End, but the two
    // directions crossed and our validator observed End/End first.
    const crossed = validator.acceptControl(
      "received",
      createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
    );
    assertEquals(crossed.disposition, "discard");
    assertEquals(validator.snapshot().activeStreamCount, 0);

    const localLateCredit = assertThrows(
      () =>
        validator.acceptControl(
          "sent",
          createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
        ),
      TypeError,
      "closed peer half",
    );
    assertEquals(
      (localLateCredit as ProtocolViolation).code,
      "post_terminal_frame",
    );
  }
});

Deno.test("protocol order: worker metadata is single-shot and precedes output", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator, "worker", STREAM_ID, false);
  const metadata = createWorkMetadataFrame({
    streamId: STREAM_ID,
    metadata: { status: 200 },
  });

  validator.acceptControl("sent", metadata);
  const violation = assertThrows(
    () => validator.acceptControl("sent", metadata),
    TypeError,
    "at most once",
  );
  assertEquals(
    (violation as ProtocolViolation).code,
    "invalid_protocol_order",
  );
  const directionViolation = assertThrows(
    () => validator.acceptControl("received", metadata),
    TypeError,
    "only be sent by a worker",
  );
  assertEquals(
    (directionViolation as ProtocolViolation).code,
    "invalid_direction",
  );

  const beforeMetadata = createReadyValidator();
  openAcceptStart(beforeMetadata, "worker", STREAM_ID, false);
  beforeMetadata.acceptControl(
    "received",
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
  );
  const dataViolation = assertThrows(
    () =>
      beforeMetadata.acceptBinary(
        "sent",
        createWorkDataFrame({
          streamId: STREAM_ID,
          sequence: 0,
          payload: new Uint8Array([1]),
        }),
      ),
    TypeError,
    "precedes work.metadata",
  );
  assertEquals(
    (dataViolation as ProtocolViolation).code,
    "invalid_protocol_order",
  );
  assertThrows(
    () =>
      beforeMetadata.acceptControl(
        "sent",
        createWorkEndFrame({ streamId: STREAM_ID }),
      ),
    TypeError,
    "precedes work.metadata",
  );
});

Deno.test("protocol order: drain waits for both terminal halves", () => {
  const validator = createReadyValidator();
  openAcceptStart(validator);
  validator.acceptControl(
    "sent",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "local shutdown",
    }),
  );
  validator.acceptControl(
    "received",
    createDrainFrame({
      connectionId: CONNECTION_ID,
      reason: "deploy",
      deadlineAtMs: Date.now() + 30_000,
    }),
  );

  assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createDrainedFrame({ connectionId: CONNECTION_ID }),
      ),
    TypeError,
    "work streams remain active",
  );

  validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId: STREAM_ID,
      reason: "cancel acknowledged",
    }),
  );
  validator.acceptControl(
    "sent",
    createDrainedFrame({ connectionId: CONNECTION_ID }),
  );
  validator.acceptControl(
    "received",
    createShutdownFrame({
      connectionId: CONNECTION_ID,
      reason: "drain complete",
    }),
  );
  assertEquals(validator.snapshot().phase, "shutdown");
});

Deno.test("protocol order: lifetime ID bound preserves strict no-reuse", () => {
  const validator = createReadyValidator("worker", {
    maxLifetimeStreams: 2,
  });

  openAcceptStart(validator, "worker", STREAM_ID);
  closeNormally(validator, "worker", STREAM_ID);
  openAcceptStart(validator, "worker", OTHER_STREAM_ID);
  closeNormally(validator, "worker", OTHER_STREAM_ID);
  assertEquals(validator.snapshot().activeStreamCount, 0);
  assertEquals(validator.snapshot().usedStreamCount, 2);

  const duplicate = assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkOpenFrame({
          streamId: STREAM_ID,
          workload: "oxian.http.v1",
          metadata: {},
        }),
      ),
    TypeError,
    "already been opened",
  );
  assertEquals((duplicate as ProtocolViolation).code, "duplicate_stream");

  const exhausted = assertThrows(
    () =>
      validator.acceptControl(
        "received",
        createWorkOpenFrame({
          streamId: THIRD_STREAM_ID,
          workload: "oxian.http.v1",
          metadata: {},
        }),
      ),
    TypeError,
    "reconnect before opening more work",
  );
  assertEquals(
    (exhausted as ProtocolViolation).code,
    "stream_limit_exceeded",
  );
});

Deno.test("protocol order: protocol_error terminates a connection", () => {
  const validator = createReadyValidator();
  validator.acceptControl(
    "received",
    createProtocolErrorFrame({
      connectionId: CONNECTION_ID,
      code: "sequence_gap",
      message: "binary frame sequence skipped",
    }),
  );
  assertEquals(validator.snapshot().phase, "protocol_error");

  assertThrows(
    () =>
      validator.acceptControl(
        "sent",
        createHeartbeatFrame({
          connectionId: CONNECTION_ID,
          sequence: 0,
          inflight: 0,
          availableCapacity: 2,
        }),
      ),
    TypeError,
    "not allowed while connection is protocol_error",
  );
});
