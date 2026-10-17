import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ControlFrame,
  createDrainedFrame,
  createDrainFrame,
  createHeartbeatFrame,
  createHelloFrame,
  createProtocolOrderValidator,
  createReadyAckFrame,
  createReadyFrame,
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
  decodeControlFrame,
  encodeControlFrame,
  HOST_CALL_CAPABILITY_KEY,
  isProtocolViolation,
  type JsonObject,
  parseControlFrame,
  type ProtocolOrderValidator,
  type ProtocolRole,
  readHostCallCapacity,
  withHostCallCapacity,
  withoutHostCallCapacity,
} from "./index.ts";

const CONNECTION = "host-call-test";
const FORWARD = "00000000-0000-4000-8000-000000000001";
const REVERSE = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const FOURTH = "00000000-0000-4000-8000-000000000004";
const ROLES = ["worker", "hypervisor"] as const;

function opposite(role: ProtocolRole): ProtocolRole {
  return role === "worker" ? "hypervisor" : "worker";
}

function control(
  validator: ProtocolOrderValidator,
  sender: ProtocolRole,
  frame: ControlFrame,
) {
  return validator.acceptControl(
    validator.snapshot().role === sender ? "sent" : "received",
    frame,
  );
}

function hello(validator: ProtocolOrderValidator) {
  control(
    validator,
    "worker",
    createHelloFrame({
      handshakeId: "handshake",
      identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
      credential: { kind: "registration", capability: "test-only" },
      capacity: 1,
      workloads: ["forward"],
    }),
  );
}

function welcome(validator: ProtocolOrderValidator, bootstrap: JsonObject) {
  return control(
    validator,
    "hypervisor",
    createWelcomeFrame({
      connectionId: CONNECTION,
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "test-only",
      resumeExpiresAtMs: 100_000,
      bootstrap,
    }),
  );
}

function ready(validator: ProtocolOrderValidator, metadata: JsonObject) {
  return control(
    validator,
    "worker",
    createReadyFrame({ connectionId: CONNECTION, capacity: 1, metadata }),
  );
}

function negotiated(
  role: ProtocolRole,
  options: { offer?: number; ack?: number; maxLifetimeStreams?: number } = {},
) {
  const validator = createProtocolOrderValidator({
    role,
    maxLifetimeStreams: options.maxLifetimeStreams,
  });
  hello(validator);
  welcome(validator, withHostCallCapacity({}, options.offer ?? 2));
  ready(validator, withHostCallCapacity({}, options.ack ?? 2));
  control(
    validator,
    "hypervisor",
    createReadyAckFrame({ connectionId: CONNECTION }),
  );
  return validator;
}

function open(
  validator: ProtocolOrderValidator,
  initiator: ProtocolRole,
  streamId: string,
  parentStreamId?: string,
) {
  return control(
    validator,
    initiator,
    createWorkOpenFrame({
      streamId,
      workload: initiator === "hypervisor" ? "forward" : "host.control",
      metadata: {},
      ...(parentStreamId === undefined ? {} : { parentStreamId }),
    }),
  );
}

function start(
  validator: ProtocolOrderValidator,
  initiator: ProtocolRole,
  streamId: string,
) {
  control(
    validator,
    opposite(initiator),
    createWorkAcceptedFrame({ streamId }),
  );
  control(validator, initiator, createWorkStartFrame({ streamId }));
}

function responseMetadata(
  validator: ProtocolOrderValidator,
  initiator: ProtocolRole,
  streamId: string,
) {
  return control(
    validator,
    opposite(initiator),
    createWorkMetadataFrame({ streamId, metadata: { ok: true } }),
  );
}

function end(
  validator: ProtocolOrderValidator,
  sender: ProtocolRole,
  streamId: string,
) {
  return control(validator, sender, createWorkEndFrame({ streamId }));
}

function cancel(
  validator: ProtocolOrderValidator,
  sender: ProtocolRole,
  streamId: string,
) {
  return control(
    validator,
    sender,
    createWorkCancelFrame({ streamId, reason: "test cancellation" }),
  );
}

function credit(
  validator: ProtocolOrderValidator,
  sender: ProtocolRole,
  streamId: string,
  bytes = 4,
) {
  return control(validator, sender, createWorkCreditFrame({ streamId, bytes }));
}

function data(
  validator: ProtocolOrderValidator,
  sender: ProtocolRole,
  streamId: string,
  sequence = 0,
  payload = new Uint8Array([1, 2]),
) {
  return validator.acceptBinary(
    validator.snapshot().role === sender ? "sent" : "received",
    createWorkDataFrame({ streamId, sequence, payload }),
  );
}

function rejectsCode(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(isProtocolViolation(error));
    assert.equal(error.code, code);
    return true;
  });
}

test("host calls: capability metadata is exact, bounded and isolated", () => {
  const application = { nested: { keep: true }, version: "application" };
  const metadata = withHostCallCapacity(application, 1_024);
  assert.equal(readHostCallCapacity(metadata), 1_024);
  assert.equal(readHostCallCapacity(application), undefined);
  assert.deepEqual(metadata[HOST_CALL_CAPABILITY_KEY], {
    version: 1,
    capacity: 1_024,
  });
  assert.deepEqual(withoutHostCallCapacity(metadata), application);
  assert.deepEqual(withoutHostCallCapacity(application), application);
  assert.notEqual(withoutHostCallCapacity(metadata).nested, application.nested);
  assert.equal(Object.hasOwn(application, HOST_CALL_CAPABILITY_KEY), false);
  rejectsCode(() => withHostCallCapacity(metadata, 1), "invalid_control_frame");
  rejectsCode(
    () =>
      withHostCallCapacity({ [HOST_CALL_CAPABILITY_KEY]: "application" }, 1),
    "invalid_control_frame",
  );
  for (const capacity of [0, -1, 1.5, 1_025, Infinity, NaN, 2 ** 53]) {
    rejectsCode(
      () => withHostCallCapacity({}, capacity),
      "invalid_control_frame",
    );
  }
});

test("host calls: malformed and partial capabilities fail closed", () => {
  const malformed: unknown[] = [
    null,
    false,
    [],
    1,
    "1",
    {},
    { version: 1 },
    { capacity: 1 },
    { version: 2, capacity: 1 },
    { version: "1", capacity: 1 },
    { version: 1, capacity: "1" },
    { version: 1, capacity: 0 },
    { version: 1, capacity: 1_025 },
    { version: 1, capacity: 1.5 },
    { version: 1, capacity: 1, extra: true },
  ];
  for (const capability of malformed) {
    const metadata = { [HOST_CALL_CAPABILITY_KEY]: capability } as JsonObject;
    rejectsCode(() => readHostCallCapacity(metadata), "invalid_control_frame");
    for (const role of ROLES) {
      const validator = createProtocolOrderValidator({ role });
      hello(validator);
      rejectsCode(() => welcome(validator, metadata), "invalid_control_frame");
      assert.equal(validator.snapshot().phase, "hello");
      welcome(validator, withHostCallCapacity({}, 2));
      rejectsCode(() => ready(validator, metadata), "invalid_control_frame");
      assert.equal(validator.snapshot().phase, "welcomed");
      assert.equal(validator.snapshot().hostCallCapacity, undefined);
    }
  }
  for (const capability of [
    undefined,
    { version: 1, capacity: NaN },
    { version: 1, capacity: Infinity },
    { version: 1, capacity: Number.MAX_SAFE_INTEGER + 1 },
    { version: 1, capacity: 1, [Symbol("extra")]: true },
    Object.assign(Object.create({ inherited: true }), {
      version: 1,
      capacity: 1,
    }),
  ]) {
    rejectsCode(
      () =>
        readHostCallCapacity({
          [HOST_CALL_CAPABILITY_KEY]: capability,
        } as JsonObject),
      "invalid_control_frame",
    );
  }
});

test("host calls: offer and acknowledgement preserve legacy ordinary-only peers", () => {
  for (const role of ROLES) {
    for (const offer of [undefined, 2]) {
      const validator = createProtocolOrderValidator({ role });
      hello(validator);
      welcome(
        validator,
        offer === undefined ? {} : withHostCallCapacity({}, offer),
      );
      ready(validator, { application: true });
      control(
        validator,
        "hypervisor",
        createReadyAckFrame({ connectionId: CONNECTION }),
      );
      assert.equal(validator.snapshot().hostCallCapacity, undefined);
      rejectsCode(
        () => open(validator, "worker", REVERSE),
        "invalid_direction",
      );
      open(validator, "hypervisor", FORWARD);
      start(validator, "hypervisor", FORWARD);
      responseMetadata(validator, "hypervisor", FORWARD);
      end(validator, "hypervisor", FORWARD);
      end(validator, "worker", FORWARD);
      assert.equal(validator.snapshot().activeStreamCount, 0);
    }
  }
});

test("host calls: unsolicited and oversized acknowledgements fail without mutation", () => {
  for (const role of ROLES) {
    for (const offer of [undefined, 1]) {
      const validator = createProtocolOrderValidator({ role });
      hello(validator);
      welcome(
        validator,
        offer === undefined ? {} : withHostCallCapacity({}, offer),
      );
      rejectsCode(
        () => ready(validator, withHostCallCapacity({}, 2)),
        offer === undefined ? "invalid_protocol_order" : "capacity_exceeded",
      );
      assert.equal(validator.snapshot().phase, "welcomed");
      assert.equal(validator.snapshot().hostCallCapacity, undefined);
    }
  }
});

test("host calls: smaller acknowledgement activates only at matching ReadyAck", () => {
  for (const role of ROLES) {
    const validator = createProtocolOrderValidator({ role });
    hello(validator);
    welcome(validator, withHostCallCapacity({}, 2));
    ready(validator, withHostCallCapacity({}, 1));
    assert.equal(validator.snapshot().hostCallCapacity, undefined);
    rejectsCode(() => open(validator, "worker", REVERSE), "invalid_direction");
    rejectsCode(
      () =>
        control(
          validator,
          "hypervisor",
          createReadyAckFrame({ connectionId: "stale" }),
        ),
      "stale_connection",
    );
    assert.equal(validator.snapshot().hostCallCapacity, undefined);
    control(
      validator,
      "hypervisor",
      createReadyAckFrame({ connectionId: CONNECTION }),
    );
    assert.equal(validator.snapshot().hostCallCapacity, 1);
    open(validator, "worker", REVERSE);
    rejectsCode(() => open(validator, "worker", OTHER), "capacity_exceeded");
  }
});

test("host calls: parent binding is a strict optional UUID and reverse-only", () => {
  const frame = createWorkOpenFrame({
    streamId: REVERSE,
    workload: "host.control",
    metadata: {},
    parentStreamId: FORWARD,
  });
  assert.deepEqual(parseControlFrame(encodeControlFrame(frame)), frame);
  for (const parentStreamId of [
    null,
    undefined,
    1,
    "invalid",
    "00000000-0000-4000-8000-00000000000G",
  ]) {
    rejectsCode(
      () => decodeControlFrame({ ...frame, parentStreamId }),
      "invalid_control_frame",
    );
  }
  rejectsCode(
    () => decodeControlFrame({ ...frame, unexpected: true }),
    "invalid_control_frame",
  );
  for (const role of ROLES) {
    const validator = negotiated(role);
    rejectsCode(
      () => open(validator, "hypervisor", FORWARD, REVERSE),
      "invalid_direction",
    );
    assert.equal(validator.snapshot().usedStreamCount, 0);
    open(validator, "worker", REVERSE, FORWARD);
  }
});

test("host calls: control directions belong to each stream initiator", () => {
  for (const role of ROLES) {
    for (const initiator of ROLES) {
      const validator = negotiated(role);
      open(validator, initiator, FORWARD);
      rejectsCode(
        () =>
          control(
            validator,
            initiator,
            createWorkAcceptedFrame({ streamId: FORWARD }),
          ),
        "invalid_direction",
      );
      rejectsCode(
        () =>
          control(
            validator,
            opposite(initiator),
            createWorkStartFrame({ streamId: FORWARD }),
          ),
        "invalid_direction",
      );
      rejectsCode(
        () =>
          control(
            validator,
            initiator,
            createWorkStartFrame({ streamId: FORWARD }),
          ),
        "invalid_protocol_order",
      );
      start(validator, initiator, FORWARD);
      rejectsCode(
        () =>
          control(
            validator,
            initiator,
            createWorkMetadataFrame({ streamId: FORWARD, metadata: {} }),
          ),
        "invalid_direction",
      );
      responseMetadata(validator, initiator, FORWARD);
      rejectsCode(
        () => responseMetadata(validator, initiator, FORWARD),
        "invalid_protocol_order",
      );
      rejectsCode(
        () =>
          control(
            validator,
            initiator,
            createWorkStartFrame({ streamId: FORWARD }),
          ),
        "invalid_protocol_order",
      );
    }
  }
});

test("host calls: reverse and forward reservations have independent capacities", () => {
  for (const role of ROLES) {
    for (const reverseFirst of [false, true]) {
      const validator = negotiated(role, { ack: 1 });
      if (reverseFirst) open(validator, "worker", REVERSE);
      open(validator, "hypervisor", FORWARD);
      if (!reverseFirst) open(validator, "worker", REVERSE);
      assert.equal(validator.snapshot().activeStreamCount, 2);
      rejectsCode(
        () => open(validator, "hypervisor", OTHER),
        "capacity_exceeded",
      );
      rejectsCode(() => open(validator, "worker", OTHER), "capacity_exceeded");
      control(
        validator,
        "worker",
        createHeartbeatFrame({
          connectionId: CONNECTION,
          sequence: 0,
          inflight: 1,
          availableCapacity: 0,
        }),
      );
      cancel(validator, role, REVERSE);
      rejectsCode(() => open(validator, "worker", OTHER), "capacity_exceeded");
      cancel(validator, opposite(role), REVERSE);
      open(validator, "worker", OTHER);
      assert.equal(validator.snapshot().activeStreamCount, 2);
    }
  }
});

test("host calls: forward declarations remain required; reverse workloads are host-owned", () => {
  for (const role of ROLES) {
    const validator = negotiated(role);
    rejectsCode(
      () =>
        control(
          validator,
          "hypervisor",
          createWorkOpenFrame({
            streamId: FORWARD,
            workload: "host.control",
            metadata: {},
          }),
        ),
      "unsupported_workload",
    );
    open(validator, "worker", REVERSE);
    assert.equal(validator.snapshot().activeStreamCount, 1);
  }
});

test("host calls: reverse data preserves start, responder metadata, credit and sequence", () => {
  for (const role of ROLES) {
    const validator = negotiated(role);
    open(validator, "worker", REVERSE);
    rejectsCode(
      () => data(validator, "worker", REVERSE),
      "invalid_protocol_order",
    );
    rejectsCode(
      () => credit(validator, "hypervisor", REVERSE),
      "invalid_protocol_order",
    );
    rejectsCode(
      () => responseMetadata(validator, "worker", REVERSE),
      "invalid_protocol_order",
    );
    start(validator, "worker", REVERSE);
    credit(validator, "worker", REVERSE);
    rejectsCode(
      () => data(validator, "hypervisor", REVERSE),
      "invalid_protocol_order",
    );
    rejectsCode(
      () => end(validator, "hypervisor", REVERSE),
      "invalid_protocol_order",
    );
    rejectsCode(() => data(validator, "worker", REVERSE), "credit_exceeded");
    responseMetadata(validator, "worker", REVERSE);
    credit(validator, "hypervisor", REVERSE);
    data(validator, "worker", REVERSE);
    data(validator, "hypervisor", REVERSE);
    rejectsCode(() => data(validator, "worker", REVERSE), "sequence_mismatch");
    rejectsCode(
      () => data(validator, "hypervisor", REVERSE, 2),
      "sequence_mismatch",
    );
    data(validator, "worker", REVERSE, 1);
    data(validator, "hypervisor", REVERSE, 1);
    rejectsCode(() => data(validator, "worker", REVERSE, 2), "credit_exceeded");
    rejectsCode(
      () => data(validator, "hypervisor", REVERSE, 2),
      "credit_exceeded",
    );
    end(validator, "worker", REVERSE);
    assert.equal(validator.snapshot().activeStreamCount, 1);
    rejectsCode(
      () => data(validator, "worker", REVERSE, 2),
      "post_terminal_frame",
    );
    end(validator, "hypervisor", REVERSE);
    assert.equal(validator.snapshot().activeStreamCount, 0);
  }
});

test("host calls: reverse crossed response is validated and discarded after local abort", () => {
  const validator = negotiated("worker");
  open(validator, "worker", REVERSE);
  start(validator, "worker", REVERSE);
  credit(validator, "worker", REVERSE);
  cancel(validator, "worker", REVERSE);
  assert.equal(
    responseMetadata(validator, "worker", REVERSE).disposition,
    "discard",
  );
  assert.equal(data(validator, "hypervisor", REVERSE).disposition, "discard");
  rejectsCode(
    () => data(validator, "hypervisor", REVERSE),
    "sequence_mismatch",
  );
  assert.equal(end(validator, "hypervisor", REVERSE).disposition, "discard");
  assert.equal(validator.snapshot().activeStreamCount, 1);
  cancel(validator, "hypervisor", REVERSE);
  assert.equal(validator.snapshot().activeStreamCount, 0);
});

test("host calls: reverse crossed acceptance is delivered before the no-replay boundary", () => {
  const validator = negotiated("worker");
  open(validator, "worker", REVERSE);
  cancel(validator, "worker", REVERSE);
  const acceptance = control(
    validator,
    "hypervisor",
    createWorkAcceptedFrame({ streamId: REVERSE }),
  );
  assert.equal(acceptance.disposition, "deliver");
  rejectsCode(
    () =>
      control(validator, "worker", createWorkStartFrame({ streamId: REVERSE })),
    "post_terminal_frame",
  );
  cancel(validator, "hypervisor", REVERSE);
  assert.equal(validator.snapshot().activeStreamCount, 0);
});

test("host calls: reverse half-close upgrades and terminal tombstones preserve wire races", () => {
  for (const role of ROLES) {
    const validator = negotiated(role);
    open(validator, "worker", REVERSE);
    start(validator, "worker", REVERSE);
    responseMetadata(validator, "worker", REVERSE);
    end(validator, role, REVERSE);
    control(
      validator,
      role,
      createWorkErrorFrame({
        streamId: REVERSE,
        code: "failed",
        message: "failed",
      }),
    );
    rejectsCode(() => cancel(validator, role, REVERSE), "post_terminal_frame");
    end(validator, opposite(role), REVERSE);
    assert.equal(validator.snapshot().activeStreamCount, 1);
    cancel(validator, opposite(role), REVERSE);
    assert.equal(validator.snapshot().activeStreamCount, 0);

    open(validator, "worker", OTHER);
    start(validator, "worker", OTHER);
    responseMetadata(validator, "worker", OTHER);
    end(validator, "worker", OTHER);
    end(validator, "hypervisor", OTHER);
    assert.equal(
      credit(validator, opposite(role), OTHER).disposition,
      "discard",
    );
    rejectsCode(() => credit(validator, role, OTHER), "post_terminal_frame");
    assert.equal(
      cancel(validator, opposite(role), OTHER).disposition,
      "discard",
    );
    assert.equal(cancel(validator, role, OTHER).disposition, "discard");
    rejectsCode(() => cancel(validator, role, OTHER), "post_terminal_frame");
    assert.equal(validator.snapshot().activeStreamCount, 0);
  }
});

test("host calls: cross-direction collisions and completed IDs cannot be reused", () => {
  for (const role of ROLES) {
    for (const initiator of ROLES) {
      const validator = negotiated(role);
      open(validator, initiator, FORWARD);
      rejectsCode(
        () => open(validator, opposite(initiator), FORWARD),
        "duplicate_stream",
      );
      start(validator, initiator, FORWARD);
      responseMetadata(validator, initiator, FORWARD);
      end(validator, initiator, FORWARD);
      end(validator, opposite(initiator), FORWARD);
      rejectsCode(
        () => open(validator, initiator, FORWARD),
        "duplicate_stream",
      );
      rejectsCode(
        () => open(validator, opposite(initiator), FORWARD),
        "duplicate_stream",
      );
      assert.equal(validator.snapshot().usedStreamCount, 1);
    }
  }
});

test("host calls: both directions share the total lifetime stream limit", () => {
  for (const role of ROLES) {
    const validator = negotiated(role, { maxLifetimeStreams: 2 });
    open(validator, "hypervisor", FORWARD);
    open(validator, "worker", REVERSE);
    cancel(validator, "worker", FORWARD);
    cancel(validator, "hypervisor", FORWARD);
    cancel(validator, "worker", REVERSE);
    cancel(validator, "hypervisor", REVERSE);
    rejectsCode(
      () => open(validator, "worker", OTHER),
      "stream_limit_exceeded",
    );
    rejectsCode(
      () => open(validator, "hypervisor", OTHER),
      "stream_limit_exceeded",
    );
    assert.equal(validator.snapshot().activeStreamCount, 0);
    assert.equal(validator.snapshot().usedStreamCount, 2);
  }
});

test("host calls: draining allows parent-bound reverse calls and waits for both directions", () => {
  for (const role of ROLES) {
    const validator = negotiated(role);
    open(validator, "hypervisor", FORWARD);
    start(validator, "hypervisor", FORWARD);
    responseMetadata(validator, "hypervisor", FORWARD);
    control(
      validator,
      "hypervisor",
      createDrainFrame({
        connectionId: CONNECTION,
        reason: "test drain",
        deadlineAtMs: 100_000,
      }),
    );
    rejectsCode(
      () => open(validator, "hypervisor", OTHER),
      "invalid_protocol_order",
    );
    rejectsCode(
      () => open(validator, "worker", REVERSE),
      "invalid_protocol_order",
    );
    open(validator, "worker", REVERSE, FORWARD);
    start(validator, "worker", REVERSE);
    responseMetadata(validator, "worker", REVERSE);
    end(validator, "hypervisor", FORWARD);
    end(validator, "worker", FORWARD);
    rejectsCode(
      () =>
        control(
          validator,
          "worker",
          createDrainedFrame({ connectionId: CONNECTION }),
        ),
      "invalid_protocol_order",
    );
    end(validator, "worker", REVERSE);
    rejectsCode(
      () =>
        control(
          validator,
          "worker",
          createDrainedFrame({ connectionId: CONNECTION }),
        ),
      "invalid_protocol_order",
    );
    end(validator, "hypervisor", REVERSE);
    control(
      validator,
      "worker",
      createDrainedFrame({ connectionId: CONNECTION }),
    );
    assert.equal(validator.snapshot().phase, "drained");
    rejectsCode(
      () => open(validator, "worker", FOURTH, FORWARD),
      "invalid_protocol_order",
    );
  }
});
