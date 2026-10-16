import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  type ControlFrame,
  createProtocolOrderValidator,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkDataFrame,
  createWorkEndFrame,
  createWorkMetadataFrame,
  createWorkOpenFrame,
  createWorkStartFrame,
  type WorkDataFrame,
  WORKER_PROTOCOL_LIMITS,
} from "../protocol/index.ts";
import type { ProtocolTransport } from "../transport/types.ts";
import type { WorkerWorkResult } from "../worker/types.ts";
import {
  createHostCallChannel,
  type HostCallHandler,
  type HostCallReservation,
} from "./host-call-channel.ts";
import { isHostCallError, type HostCallError } from "./host-call.ts";

const STREAM_ID = "00000000-0000-4000-8000-000000000001";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeTransport(
  onControl?: (frame: ControlFrame) => void | Promise<void>,
  onData?: (frame: WorkDataFrame) => void | Promise<void>,
) {
  const controls: ControlFrame[] = [];
  const data: WorkDataFrame[] = [];
  let closes = 0;
  const transport: ProtocolTransport = {
    async sendControl(frame) {
      controls.push(frame);
      await onControl?.(frame);
      return { frame, disposition: "deliver" };
    },
    async sendData(frame) {
      data.push(frame);
      await onData?.(frame);
      return { frame, disposition: "deliver" };
    },
    async *messages() {},
    snapshot: () => createProtocolOrderValidator({ role: "worker" }).snapshot(),
    close() {
      closes++;
      return Promise.resolve();
    },
    closed: Promise.resolve({ code: 1000, reason: "test", wasClean: true }),
  };
  return { transport, controls, data, closes: () => closes };
}

function outgoingLedger() {
  let occupied = 0;
  let releases = 0;
  return {
    reserve() {
      if (occupied !== 0) return undefined;
      occupied++;
      let released = false;
      return {
        release() {
          assert.equal(released, false, "reservation releases exactly once");
          released = true;
          occupied--;
          releases++;
        },
      };
    },
    occupied: () => occupied,
    releases: () => releases,
  };
}

function host(
  t: TestContext,
  admit: HostCallReservation["admit"],
  wire = fakeTransport(),
  now = Date.now,
) {
  let releases = 0;
  const signal = new AbortController();
  const channel = createHostCallChannel({
    role: "hypervisor",
    transport: wire.transport,
    signal: signal.signal,
    capacity: 1,
    timeoutMs: 30_000,
    now,
    accept: () => ({
      admit,
      current: () => true,
      release() {
        releases++;
      },
    }),
  });
  t.after(() => channel.close());
  const open = (deadlineAtMs?: number) => {
    channel.control(
      createWorkOpenFrame({
        streamId: STREAM_ID,
        workload: "host.test",
        metadata: {},
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      }),
      "deliver",
    );
  };
  return {
    channel,
    signal,
    wire,
    open,
    start: () =>
      channel.control(createWorkStartFrame({ streamId: STREAM_ID }), "deliver"),
    releases: () => releases,
  };
}

function expectCallError(
  code: HostCallError["code"],
  execution: HostCallError["execution"],
) {
  return (error: unknown) => {
    assert.ok(isHostCallError(error));
    assert.equal(error.code, code);
    assert.equal(error.execution, execution);
    return true;
  };
}

test("host call channel: pre-acceptance cancellation owns and drains pending request bodies", async (t) => {
  for (const mode of ["handle", "signal", "close"] as const) {
    const cleanup = deferred<void>();
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
        return cleanup.promise;
      },
    });
    const ledger = outgoingLedger();
    const signal = new AbortController();
    const callerAbort = new AbortController();
    const channel = createHostCallChannel({
      role: "worker",
      transport: fakeTransport().transport,
      signal: signal.signal,
      capacity: 1,
      timeoutMs: 30_000,
      reserveOutgoing: ledger.reserve,
    });
    t.after(() => {
      cleanup.resolve();
      channel.close();
    });
    const call = await channel.call({
      workload: "host.test",
      body,
      signal: callerAbort.signal,
    });
    if (mode === "handle") await call.cancel();
    else if (mode === "signal") callerAbort.abort();
    else channel.close();
    await setImmediate();
    assert.equal(cancellations, 1, mode);
    await assert.rejects(
      call.started,
      expectCallError(
        mode === "close" ? "connection_lost" : "cancelled",
        "not_started",
      ),
    );
    await assert.rejects(call.completed, isHostCallError);
    channel.close();
    assert.equal(channel.active(), 0);
    assert.equal(
      ledger.occupied(),
      1,
      "closing does not release pending body cleanup",
    );
    const replacement = createHostCallChannel({
      role: "worker",
      transport: fakeTransport().transport,
      signal: new AbortController().signal,
      capacity: 1,
      timeoutMs: 30_000,
      reserveOutgoing: ledger.reserve,
    });
    t.after(() => replacement.close());
    await assert.rejects(
      replacement.call({ workload: "host.test" }),
      expectCallError("capacity", "not_started"),
    );
    cleanup.resolve();
    await setImmediate();
    assert.equal(ledger.occupied(), 0);
    assert.equal(ledger.releases(), 1);
    const next = await replacement.call({ workload: "host.test" });
    await next.cancel();
    replacement.close();
  }
});

test("host call channel: response metadata send failure cancels the returned source before releasing", async (t) => {
  const cleanup = deferred<void>();
  t.after(() => cleanup.resolve());
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const fixture = host(
    t,
    () => () => body,
    fakeTransport((frame) => {
      if (frame.type === "work.metadata")
        throw new Error("injected metadata send failure");
    }),
  );
  fixture.open();
  await setImmediate();
  fixture.start();
  await setImmediate();
  assert.equal(cancellations, 1);
  assert.equal(fixture.releases(), 0);
  fixture.channel.close();
  assert.equal(fixture.releases(), 0);
  cleanup.resolve();
  await setImmediate();
  assert.equal(fixture.releases(), 1);
  assert.equal(body.locked, false);
});

test("host call channel: malformed handler results retain their body cleanup reservation", async (t) => {
  const cleanup = deferred<void>();
  t.after(() => cleanup.resolve());
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const fixture = host(
    t,
    () => () => ({ body, unexpected: true }) as unknown as WorkerWorkResult,
  );
  fixture.open();
  await setImmediate();
  fixture.start();
  await setImmediate();
  assert.equal(cancellations, 1);
  assert.equal(fixture.releases(), 0);
  fixture.channel.close();
  assert.equal(fixture.releases(), 0);
  cleanup.resolve();
  await setImmediate();
  assert.equal(fixture.releases(), 1);
  assert.equal(body.locked, false);
});

test("host call channel: oversized response chunks retain admission until source cancellation settles", async (t) => {
  const cleanup = deferred<void>();
  t.after(() => cleanup.resolve());
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new Uint8Array(WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes + 1),
      );
    },
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const fixture = host(t, () => () => body);
  fixture.open();
  await setImmediate();
  fixture.start();
  await setImmediate();
  assert.equal(cancellations, 1);
  assert.equal(fixture.wire.data.length, 0);
  assert.equal(fixture.releases(), 0);
  fixture.channel.close();
  assert.equal(fixture.releases(), 0);
  cleanup.resolve();
  await setImmediate();
  assert.equal(fixture.releases(), 1);
  assert.equal(body.locked, false);
});

test("host call channel: data send failure cancels source while still owning its reader", async (t) => {
  const cleanup = deferred<void>();
  t.after(() => cleanup.resolve());
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const fixture = host(
    t,
    () => () => body,
    fakeTransport(undefined, () => {
      throw new Error("injected data send failure");
    }),
  );
  fixture.open();
  await setImmediate();
  fixture.start();
  fixture.channel.control(
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
    "deliver",
  );
  await setImmediate();
  assert.equal(cancellations, 1);
  fixture.channel.close();
  assert.equal(fixture.releases(), 0);
  cleanup.resolve();
  await setImmediate();
  assert.equal(fixture.releases(), 1);
  assert.equal(body.locked, false);
});

test("host call channel: admission reservation survives disconnect until admission settles", async (t) => {
  const admission = deferred<HostCallHandler>();
  let calls = 0;
  const handler = () => {
    calls++;
  };
  const fixture = host(t, () => admission.promise);
  t.after(() => admission.resolve(handler));
  fixture.open();
  fixture.signal.abort();
  assert.equal(fixture.channel.active(), 0);
  assert.equal(fixture.releases(), 0);
  admission.resolve(handler);
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(fixture.releases(), 1);
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.accepted"),
    false,
  );
});

test("host call channel: late handler output after disconnect is cancelled before admission releases", async (t) => {
  const result = deferred<WorkerWorkResult>();
  const cleanup = deferred<void>();
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const fixture = host(t, () => () => result.promise);
  t.after(() => {
    result.resolve(body);
    cleanup.resolve();
  });
  fixture.open();
  await setImmediate();
  fixture.start();
  fixture.channel.close();
  assert.equal(fixture.releases(), 0);
  result.resolve(body);
  await setImmediate();
  assert.equal(cancellations, 1);
  assert.equal(fixture.releases(), 0);
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.metadata"),
    false,
  );
  cleanup.resolve();
  await setImmediate();
  assert.equal(fixture.releases(), 1);
});

test("host call channel: host request consumer cancellation leaves the response half usable", async (t) => {
  const fixture = host(t, () => async ({ input }) => {
    await input.cancel();
    return new Uint8Array([7]);
  });
  fixture.open();
  await setImmediate();
  fixture.start();
  fixture.channel.control(
    createWorkCreditFrame({ streamId: STREAM_ID, bytes: 1 }),
    "deliver",
  );
  await setImmediate();
  assert.equal(
    fixture.wire.controls.some(
      (frame) => frame.type === "work.error" || frame.type === "work.cancel",
    ),
    false,
  );
  assert.deepEqual(
    fixture.wire.data.map((frame) => Array.from(frame.payload)),
    [[7]],
  );
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.metadata"),
    true,
  );
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.end"),
    true,
  );
  assert.doesNotThrow(() =>
    fixture.channel.data(
      createWorkDataFrame({
        streamId: STREAM_ID,
        sequence: 0,
        payload: new Uint8Array([1]),
      }),
      "deliver",
    ),
  );
  fixture.channel.control(
    createWorkEndFrame({ streamId: STREAM_ID }),
    "deliver",
  );
  assert.equal(fixture.channel.active(), 0);
  assert.equal(fixture.releases(), 1);
});

test("host call channel: admission completing after deadline never emits accepted", async (t) => {
  const admission = deferred<HostCallHandler>();
  let time = 1_000;
  let calls = 0;
  const handler = () => {
    calls++;
  };
  const fixture = host(
    t,
    () => admission.promise,
    undefined,
    () => time,
  );
  t.after(() => admission.resolve(handler));
  fixture.open(2_000);
  time = 2_000;
  admission.resolve(handler);
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(fixture.releases(), 1);
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.accepted"),
    false,
  );
  assert.equal(
    fixture.wire.controls.some(
      (frame) =>
        frame.type === "work.error" && frame.code === "deadline_exceeded",
    ),
    true,
  );
});

test("host call channel: accepted host call checks deadline again immediately before handler entry", async (t) => {
  let time = 1_000;
  let calls = 0;
  const fixture = host(
    t,
    () => () => {
      calls++;
    },
    undefined,
    () => time,
  );
  fixture.open(2_000);
  await setImmediate();
  assert.equal(
    fixture.wire.controls.some((frame) => frame.type === "work.accepted"),
    true,
  );
  time = 2_000;
  fixture.start();
  await setImmediate();
  assert.equal(calls, 0);
  assert.equal(fixture.releases(), 1);
  assert.equal(
    fixture.wire.controls.some(
      (frame) =>
        frame.type === "work.error" && frame.code === "deadline_exceeded",
    ),
    true,
  );
});

test("host call channel: caller does not start accepted work after its deadline", async (t) => {
  let time = 1_000;
  const wire = fakeTransport();
  const channel = createHostCallChannel({
    role: "worker",
    transport: wire.transport,
    signal: new AbortController().signal,
    capacity: 1,
    timeoutMs: 30_000,
    now: () => time,
  });
  t.after(() => channel.close());
  const call = await channel.call({
    workload: "host.test",
    deadlineAtMs: 2_000,
  });
  time = 2_000;
  channel.control(
    createWorkAcceptedFrame({ streamId: call.streamId }),
    "deliver",
  );
  await assert.rejects(
    call.started,
    expectCallError("deadline_exceeded", "not_started"),
  );
  assert.equal(
    wire.controls.some((frame) => frame.type === "work.start"),
    false,
  );
});

test("host call channel: already-locked caller body is refused without taking capacity", async (t) => {
  const body = new ReadableStream<Uint8Array>();
  const reader = body.getReader();
  const ledger = outgoingLedger();
  const channel = createHostCallChannel({
    role: "worker",
    transport: fakeTransport().transport,
    signal: new AbortController().signal,
    capacity: 1,
    timeoutMs: 30_000,
    reserveOutgoing: ledger.reserve,
  });
  t.after(() => {
    reader.releaseLock();
    channel.close();
  });
  await assert.rejects(
    channel.call({ workload: "host.test", body }),
    TypeError,
  );
  assert.equal(channel.active(), 0);
  assert.equal(ledger.occupied(), 0);
});

test("host call channel: failed reader acquisition cannot strand outgoing reservations", async (t) => {
  const body = new ReadableStream<Uint8Array>();
  const ledger = outgoingLedger();
  const channel = createHostCallChannel({
    role: "worker",
    transport: fakeTransport().transport,
    signal: new AbortController().signal,
    capacity: 1,
    timeoutMs: 30_000,
    reserveOutgoing: ledger.reserve,
  });
  const call = await channel.call({ workload: "host.test", body });
  // Caller misuse after ownership transfer still must not strand library capacity.
  const reader = body.getReader();
  t.after(() => {
    reader.releaseLock();
    channel.close();
  });
  channel.control(
    createWorkAcceptedFrame({ streamId: call.streamId }),
    "deliver",
  );
  await setImmediate();
  channel.control(
    createWorkCancelFrame({ streamId: call.streamId, reason: "acknowledge" }),
    "deliver",
  );
  channel.close();
  await setImmediate();
  assert.equal(channel.active(), 0);
  assert.equal(ledger.occupied(), 0);
  assert.equal(ledger.releases(), 1);
});

test("host call channel: an early complete response cancels the request source without failing success", async (t) => {
  const cleanup = deferred<void>();
  t.after(() => cleanup.resolve());
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations++;
      return cleanup.promise;
    },
  });
  const ledger = outgoingLedger();
  const wire = fakeTransport();
  const channel = createHostCallChannel({
    role: "worker",
    transport: wire.transport,
    signal: new AbortController().signal,
    capacity: 1,
    timeoutMs: 30_000,
    reserveOutgoing: ledger.reserve,
  });
  t.after(() => channel.close());
  const call = await channel.call({ workload: "host.test", body });
  channel.control(
    createWorkAcceptedFrame({ streamId: call.streamId }),
    "deliver",
  );
  await call.started;
  channel.control(
    createWorkMetadataFrame({
      streamId: call.streamId,
      metadata: { ok: true },
    }),
    "deliver",
  );
  channel.control(createWorkEndFrame({ streamId: call.streamId }), "deliver");
  await call.completed;
  assert.deepEqual(await call.metadata, { ok: true });
  assert.equal(cancellations, 1);
  assert.equal(ledger.occupied(), 1);
  assert.equal(
    wire.controls.some(
      (frame) => frame.type === "work.error" || frame.type === "work.cancel",
    ),
    false,
  );
  cleanup.resolve();
  await setImmediate();
  assert.equal(ledger.occupied(), 0);
});
