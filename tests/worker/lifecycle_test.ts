import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createDrainFrame,
  createHelloFrame,
  createProtocolOrderValidator,
  createReadyAckFrame,
  createReadyFrame,
  createShutdownFrame,
  createStreamId,
  createWelcomeFrame,
  createWorkAcceptedFrame,
  createWorkCancelFrame,
  createWorkCreditFrame,
  createWorkDataFrame,
  createWorkEndFrame,
  createWorkOpenFrame,
  createWorkStartFrame,
  encodeControlFrame,
  type HelloFrame,
} from "../../src/protocol/index.ts";
import { createProtocolTestWorker as createWorker } from "./protocol_worker.ts";
import {
  acceptTestHandshake,
  nextControl,
  nextMessage,
  startTestPeer,
  type TestPeerConnection,
  withTimeout,
} from "./test_peer.ts";

const IDENTITY = Object.freeze({
  workerId: "worker-lifecycle",
  attemptId: "attempt-1",
  epoch: 1,
});

async function openAndStart(
  connection: TestPeerConnection,
  streamId: string,
): Promise<void> {
  await connection.transport.sendControl(createWorkOpenFrame({
    streamId,
    workload: "echo",
    metadata: { request: streamId },
  }));
  const accepted = await nextControl(connection, "work.accepted");
  assertEquals(
    "streamId" in accepted.acceptance.frame
      ? accepted.acceptance.frame.streamId
      : undefined,
    streamId,
  );
  await connection.transport.sendControl(createWorkStartFrame({ streamId }));
}

async function shutdown(
  connection: TestPeerConnection,
  connectionId: string,
): Promise<void> {
  await connection.transport.sendControl(createShutdownFrame({
    connectionId,
    reason: "test_complete",
  }));
}

Deno.test("worker multiplexes concurrent credited streams", async () => {
  const peer = await startTestPeer();
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: ({ streamId }) => new TextEncoder().encode(`response:${streamId}`),
    },
    capacity: 2,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const streamIds = [createStreamId(), createStreamId()];

    for (const streamId of streamIds) {
      await connection.transport.sendControl(createWorkOpenFrame({
        streamId,
        workload: "echo",
        metadata: {},
      }));
    }
    const accepted = new Set<string>();
    while (accepted.size < 2) {
      const message = await nextControl(connection);
      if (message.acceptance.frame.type === "work.accepted") {
        accepted.add(message.acceptance.frame.streamId);
      }
    }
    assertEquals(accepted, new Set(streamIds));

    for (const streamId of streamIds) {
      await connection.transport.sendControl(
        createWorkStartFrame({ streamId }),
      );
      await connection.transport.sendControl(
        createWorkCreditFrame({ streamId, bytes: 1024 }),
      );
      await connection.transport.sendControl(
        createWorkEndFrame({ streamId }),
      );
    }

    const metadata = new Set<string>();
    const ended = new Set<string>();
    const output = new Map<string, number[]>();
    while (ended.size < 2) {
      const message = await nextMessage(connection);
      if (message.kind === "data") {
        const bytes = output.get(message.acceptance.frame.streamId) ?? [];
        bytes.push(...message.acceptance.frame.payload);
        output.set(message.acceptance.frame.streamId, bytes);
      } else if (message.acceptance.frame.type === "work.metadata") {
        metadata.add(message.acceptance.frame.streamId);
      } else if (message.acceptance.frame.type === "work.end") {
        ended.add(message.acceptance.frame.streamId);
      }
    }

    assertEquals(metadata, new Set(streamIds));
    for (const streamId of streamIds) {
      assertEquals(
        new TextDecoder().decode(
          new Uint8Array(output.get(streamId) ?? []),
        ),
        `response:${streamId}`,
      );
    }
    assertEquals(connection.transport.snapshot().activeStreamCount, 0);
    assertEquals(client.snapshot().activeStreams, 0);
    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("ignored request body stops at credit while response finishes promptly", async () => {
  const peer = await startTestPeer();
  const response = new Uint8Array(128 * 1024).fill(7);
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => response },
    reconnectDelay: () => 0,
    inputBufferBytes: 64 * 1024,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const streamId = createStreamId();
    await openAndStart(connection, streamId);
    await connection.transport.sendControl(
      createWorkCreditFrame({ streamId, bytes: response.byteLength }),
    );

    let inputCredit = 0;
    let inputSequence = 0;
    let producedBytes = 0;
    let responseBytes = 0;
    let sawMetadata = false;
    let sawOutputEnd = false;
    let producer: Promise<void> = Promise.resolve();
    const chunk = new Uint8Array(16 * 1024).fill(3);
    const startedAt = performance.now();

    const pumpInput = (): void => {
      producer = producer.then(async () => {
        while (!sawOutputEnd && inputCredit >= chunk.byteLength) {
          inputCredit -= chunk.byteLength;
          await connection.transport.sendData(createWorkDataFrame({
            streamId,
            sequence: inputSequence++,
            payload: chunk,
          }));
          producedBytes += chunk.byteLength;
        }
      });
    };

    while (!sawOutputEnd) {
      const message = await nextMessage(connection);
      if (message.kind === "data") {
        responseBytes += message.acceptance.frame.payload.byteLength;
      } else if (
        message.acceptance.frame.type === "work.credit" &&
        message.acceptance.frame.streamId === streamId
      ) {
        inputCredit += message.acceptance.frame.bytes;
        pumpInput();
      } else if (
        message.acceptance.frame.type === "work.metadata" &&
        message.acceptance.frame.streamId === streamId
      ) {
        sawMetadata = true;
      } else if (
        message.acceptance.frame.type === "work.end" &&
        message.acceptance.frame.streamId === streamId
      ) {
        sawOutputEnd = true;
      }
    }
    await producer;
    // The Hypervisor stops its upload producer at the worker response terminal
    // and closes the request half, releasing worker capacity.
    await connection.transport.sendControl(createWorkEndFrame({ streamId }));

    assert(sawMetadata);
    assertEquals(responseBytes, response.byteLength);
    assert(
      producedBytes <= 64 * 1024,
      "ignored input must not receive unbounded credit",
    );
    assert(
      performance.now() - startedAt < 1_000,
      "response must not wait for an ignored/infinite request body",
    );
    assertEquals(connection.transport.snapshot().activeStreamCount, 0);
    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("slow output reader applies credit backpressure to native stream", async () => {
  const peer = await startTestPeer();
  const chunkBytes = 32 * 1024;
  const chunkCount = 6;
  let produced = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (produced === chunkCount) {
              controller.close();
              return;
            }
            produced++;
            controller.enqueue(new Uint8Array(chunkBytes).fill(produced));
          },
        }),
    },
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const streamId = createStreamId();
    await openAndStart(connection, streamId);
    await nextControl(connection, "work.metadata");
    assert(
      produced <= 2,
      "worker may stage at most one bounded producer chunk beyond demand",
    );

    let received = 0;
    while (received < chunkCount) {
      await connection.transport.sendControl(
        createWorkCreditFrame({ streamId, bytes: chunkBytes }),
      );
      while (true) {
        const message = await nextMessage(connection);
        if (
          message.kind === "data" &&
          message.acceptance.frame.streamId === streamId
        ) {
          assertEquals(
            message.acceptance.frame.payload.byteLength,
            chunkBytes,
          );
          received++;
          break;
        }
      }
      assert(
        produced <= received + 2,
        "producer must remain bounded behind slow peer credit",
      );
    }
    await nextControl(connection, "work.end");
    await connection.transport.sendControl(createWorkEndFrame({ streamId }));
    assertEquals(connection.transport.snapshot().activeStreamCount, 0);

    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("remote cancel aborts handler and receives directional acknowledgement", async () => {
  const peer = await startTestPeer();
  let aborted = false;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          }, { once: true });
        }),
    },
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const streamId = createStreamId();
    await openAndStart(connection, streamId);
    await connection.transport.sendControl(createWorkCancelFrame({
      streamId,
      reason: "caller_cancelled",
    }));
    const acknowledgement = await nextControl(
      connection,
      "work.cancel",
    );
    assertEquals(
      "streamId" in acknowledgement.acceptance.frame
        ? acknowledgement.acceptance.frame.streamId
        : undefined,
      streamId,
    );
    assert(aborted);
    assertEquals(connection.transport.snapshot().activeStreamCount, 0);

    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("deadline rejection discards a crossed Start after Accepted", async () => {
  const peer = await startTestPeer();
  let invocations = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
      },
    },
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const streamId = createStreamId();
    await connection.transport.sendControl(createWorkOpenFrame({
      streamId,
      workload: "echo",
      metadata: {},
      deadlineAtMs: Date.now() + 25,
    }));
    await nextControl(connection, "work.accepted");
    const deadlineCancel = await nextControl(connection, "work.cancel");
    assertEquals(
      deadlineCancel.acceptance.frame.type === "work.cancel"
        ? deadlineCancel.acceptance.frame.reason
        : undefined,
      "deadline_exceeded",
    );

    // Bypass the Hypervisor's local validator to model a Start already on the
    // wire before it observed the worker's deadline cancel.
    connection.socket.send(encodeControlFrame(
      createWorkStartFrame({ streamId }),
    ));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(invocations, 0);
    await connection.transport.sendControl(createWorkCancelFrame({
      streamId,
      reason: "deadline_acknowledged",
    }));
    assertEquals(connection.transport.snapshot().activeStreamCount, 0);

    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("loss before Start never invokes; loss after Start aborts without replay", async () => {
  const peer = await startTestPeer();
  let invocations = 0;
  let aborts = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: ({ signal }) => {
        invocations++;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts++;
            reject(signal.reason);
          }, { once: true });
        });
      },
    },
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const beforeStart = await peer.nextConnection();
    await acceptTestHandshake(beforeStart);
    const stream1 = createStreamId();
    await beforeStart.transport.sendControl(createWorkOpenFrame({
      streamId: stream1,
      workload: "echo",
      metadata: {},
    }));
    await nextControl(beforeStart, "work.accepted");
    await beforeStart.transport.close({
      code: 1000,
      reason: "loss_before_start",
    });
    assertEquals(invocations, 0);

    const afterStart = await peer.nextConnection();
    await acceptTestHandshake(afterStart);
    const stream2 = createStreamId();
    await openAndStart(afterStart, stream2);
    await withTimeout(
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (invocations === 1) resolve();
          else setTimeout(check, 1);
        };
        check();
      }),
    );
    await afterStart.transport.close({
      code: 1000,
      reason: "loss_after_start",
    });

    const finalConnection = await peer.nextConnection();
    const finalHandshake = await acceptTestHandshake(finalConnection);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(invocations, 1);
    assertEquals(aborts, 1);
    assertEquals(client.snapshot().activeStreams, 0);
    await shutdown(finalConnection, finalHandshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("drained waits: peer close reconnects, explicit Shutdown stops", async () => {
  const peer = await startTestPeer();
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    const firstHandshake = await acceptTestHandshake(first);
    await first.transport.sendControl(createDrainFrame({
      connectionId: firstHandshake.welcome.connectionId,
      reason: "max_connection_age",
      deadlineAtMs: Date.now() + 5_000,
    }));
    await nextControl(first, "drained");
    assertEquals(
      await Promise.race([
        first.transport.closed.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("open"), 25)),
      ]),
      "open",
    );
    await first.transport.close({
      code: 1000,
      reason: "proactive_rotation",
    });

    const second = await peer.nextConnection();
    const secondHandshake = await acceptTestHandshake(second);
    assertEquals(
      (secondHandshake.hello as HelloFrame).credential.kind,
      "resume",
    );
    await second.transport.sendControl(createDrainFrame({
      connectionId: secondHandshake.welcome.connectionId,
      reason: "terminal_shutdown",
      deadlineAtMs: Date.now() + 5_000,
    }));
    await nextControl(second, "drained");
    await shutdown(second, secondHandshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("resume rotation rejects racing Open as retryable before acceptance", async () => {
  const peer = await startTestPeer();
  let invocations = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: ({ signal }) => {
        invocations++;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    },
    capacity: 2,
    reconnectDelay: () => 0,
    resumeExpirySkewMs: 400,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await acceptTestHandshake(first, {
      resumeExpiresAtMs: Date.now() + 500,
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    await nextControl(first, "heartbeat");
    const activeStream = createStreamId();
    await openAndStart(first, activeStream);

    await withTimeout(
      new Promise<void>((resolve) => {
        const check = (): void => {
          if (client.snapshot().state === "draining") resolve();
          else setTimeout(check, 2);
        };
        check();
      }),
    );
    let drainingAvailability: number | undefined;
    while (drainingAvailability !== 0) {
      const heartbeat = await nextControl(first, "heartbeat");
      drainingAvailability = heartbeat.acceptance.frame.type === "heartbeat"
        ? heartbeat.acceptance.frame.availableCapacity
        : undefined;
    }

    const racingStream = createStreamId();
    await first.transport.sendControl(createWorkOpenFrame({
      streamId: racingStream,
      workload: "echo",
      metadata: {},
    }));
    const rejection = await nextControl(first, "work.cancel");
    if (rejection.acceptance.frame.type !== "work.cancel") {
      throw new TypeError("expected pre-accept draining rejection");
    }
    assertEquals(rejection.acceptance.frame.streamId, racingStream);
    assertEquals(rejection.acceptance.frame.reason, "worker_draining");
    assertEquals(invocations, 1);
    await first.transport.sendControl(createWorkCancelFrame({
      streamId: racingStream,
      reason: "retry_acknowledged",
    }));

    await first.transport.sendControl(createWorkCancelFrame({
      streamId: activeStream,
      reason: "finish_rotation",
    }));
    await nextControl(first, "work.cancel");
    await first.transport.closed;

    const second = await peer.nextConnection();
    const secondHandshake = await acceptTestHandshake(second);
    assertEquals(invocations, 1);
    await shutdown(second, secondHandshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("hung execution keeps process capacity across cancel and reconnect", async () => {
  const peer = await startTestPeer();
  let invocations = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
        return new Promise<void>(() => undefined);
      },
    },
    capacity: 1,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await acceptTestHandshake(first);
    const hungStream = createStreamId();
    await openAndStart(first, hungStream);
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (invocations === 1) resolve();
          else setTimeout(poll, 1);
        };
        poll();
      }),
    );

    await first.transport.sendControl(createWorkCancelFrame({
      streamId: hungStream,
      reason: "caller_cancelled",
    }));
    await nextControl(first, "work.cancel");
    assertEquals(client.snapshot().activeStreams, 0);
    assertEquals(client.snapshot().occupiedExecutions, 1);
    await first.transport.close({
      code: 1000,
      reason: "reconnect_after_cancel",
    });

    const second = await peer.nextConnection();
    const secondHandshake = await acceptTestHandshake(second, {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    const heartbeat = await nextControl(second, "heartbeat");
    if (heartbeat.acceptance.frame.type !== "heartbeat") {
      throw new TypeError("expected heartbeat");
    }
    assertEquals(heartbeat.acceptance.frame.inflight, 1);
    assertEquals(heartbeat.acceptance.frame.availableCapacity, 0);

    const rejectedStream = createStreamId();
    await second.transport.sendControl(createWorkOpenFrame({
      streamId: rejectedStream,
      workload: "echo",
      metadata: {},
    }));
    const rejection = await nextControl(second, "work.cancel");
    if (rejection.acceptance.frame.type !== "work.cancel") {
      throw new TypeError("expected capacity rejection");
    }
    assertEquals(rejection.acceptance.frame.streamId, rejectedStream);
    assertEquals(rejection.acceptance.frame.reason, "worker_capacity");
    assertEquals(invocations, 1);
    await second.transport.sendControl(createWorkCancelFrame({
      streamId: rejectedStream,
      reason: "capacity_rejection_ack",
    }));

    await second.transport.sendControl(createDrainFrame({
      connectionId: secondHandshake.welcome.connectionId,
      reason: "test_drain",
      deadlineAtMs: Date.now() + 5_000,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(client.snapshot().state, "draining");
    assertEquals(client.snapshot().occupiedExecutions, 1);

    await withTimeout(client.stop("hung_execution_test"));
    assertEquals(await withTimeout(run), { reason: "stopped" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("deferred output cancellation holds capacity and Drain until source settlement", async () => {
  const peer = await startTestPeer();
  const output = deferredCancellationOutput();
  let invocations = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
        return output.body;
      },
    },
    capacity: 1,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const activeStream = createStreamId();
    await openAndStart(connection, activeStream);
    await output.pulling;

    await connection.transport.sendControl(createWorkCancelFrame({
      streamId: activeStream,
      reason: "caller_cancelled",
    }));
    await nextControl(connection, "work.cancel");
    await output.cancelling;
    assertEquals(client.snapshot().activeStreams, 0);
    assertEquals(client.snapshot().occupiedExecutions, 1);
    assertEquals(output.cancelCalls(), 1);

    const capacityProbe = createStreamId();
    await connection.transport.sendControl(createWorkOpenFrame({
      streamId: capacityProbe,
      workload: "echo",
      metadata: {},
    }));
    const rejection = await nextControl(connection, "work.cancel");
    if (rejection.acceptance.frame.type !== "work.cancel") {
      throw new TypeError("expected capacity rejection");
    }
    assertEquals(rejection.acceptance.frame.streamId, capacityProbe);
    assertEquals(rejection.acceptance.frame.reason, "worker_capacity");
    assertEquals(invocations, 1);
    await connection.transport.sendControl(createWorkCancelFrame({
      streamId: capacityProbe,
      reason: "capacity_rejection_acknowledged",
    }));

    await connection.transport.sendControl(createDrainFrame({
      connectionId: handshake.welcome.connectionId,
      reason: "deferred_output_cancellation",
      deadlineAtMs: Date.now() + 5_000,
    }));
    let drained = false;
    const drain = nextControl(connection, "drained").then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(client.snapshot().state, "draining");
    assertEquals(client.snapshot().occupiedExecutions, 1);
    assertEquals(drained, false);
    assertEquals(output.settled(), false);

    output.release();
    await withTimeout(drain);
    assertEquals(output.settled(), true);
    assertEquals(client.snapshot().occupiedExecutions, 0);
    assertEquals(client.snapshot().state, "drained");

    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    output.release();
    await client.stop();
    await peer.close();
  }
});

Deno.test("deferred output cancellation keeps replacement-session capacity occupied", async () => {
  const peer = await startTestPeer();
  const output = deferredCancellationOutput();
  let invocations = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
        return output.body;
      },
    },
    capacity: 1,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await acceptTestHandshake(first);
    const activeStream = createStreamId();
    await openAndStart(first, activeStream);
    await output.pulling;
    await first.transport.close({
      code: 1000,
      reason: "connection_lost_during_output",
    });
    await output.cancelling;
    assertEquals(client.snapshot().occupiedExecutions, 1);
    assertEquals(output.settled(), false);

    const second = await peer.nextConnection();
    const secondHandshake = await acceptTestHandshake(second, {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    let occupiedHeartbeat:
      | Extract<
        Awaited<ReturnType<typeof nextControl>>["acceptance"]["frame"],
        { type: "heartbeat" }
      >
      | undefined;
    while (occupiedHeartbeat === undefined) {
      const message = await nextControl(second, "heartbeat");
      if (message.acceptance.frame.type === "heartbeat") {
        occupiedHeartbeat = message.acceptance.frame;
      }
    }
    assertEquals(occupiedHeartbeat.inflight, 1);
    assertEquals(occupiedHeartbeat.availableCapacity, 0);

    const capacityProbe = createStreamId();
    await second.transport.sendControl(createWorkOpenFrame({
      streamId: capacityProbe,
      workload: "echo",
      metadata: {},
    }));
    const rejection = await nextControl(second, "work.cancel");
    if (rejection.acceptance.frame.type !== "work.cancel") {
      throw new TypeError("expected replacement-session capacity rejection");
    }
    assertEquals(rejection.acceptance.frame.reason, "worker_capacity");
    assertEquals(invocations, 1);
    await second.transport.sendControl(createWorkCancelFrame({
      streamId: capacityProbe,
      reason: "capacity_rejection_acknowledged",
    }));

    output.release();
    await waitForSnapshot(() => client.snapshot().occupiedExecutions === 0);
    assertEquals(output.settled(), true);
    let availableCapacity = 0;
    while (availableCapacity !== 1) {
      const heartbeat = await nextControl(second, "heartbeat");
      if (heartbeat.acceptance.frame.type === "heartbeat") {
        availableCapacity = heartbeat.acceptance.frame.availableCapacity;
      }
    }

    await shutdown(second, secondHandshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    output.release();
    await client.stop();
    await peer.close();
  }
});

Deno.test("run waits for deferred output cancellation after terminal connection loss", async () => {
  const peer = await startTestPeer();
  const output = deferredCancellationOutput();
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => output.body },
    capacity: 1,
    reconnectDelay: false,
  });
  const run = client.closed;
  let runSettled = false;
  void run.then(() => {
    runSettled = true;
  });

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const activeStream = createStreamId();
    await openAndStart(connection, activeStream);
    await output.pulling;
    await connection.transport.close({
      code: 1000,
      reason: "terminal_connection_loss",
    });
    await output.cancelling;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(runSettled, false);
    assertEquals(client.snapshot().occupiedExecutions, 1);
    assertEquals(output.settled(), false);

    output.release();
    assertEquals((await withTimeout(run)).reason, "reconnect_exhausted");
    assertEquals(output.settled(), true);
    assertEquals(client.snapshot().occupiedExecutions, 0);
    assertEquals(client.snapshot().state, "stopped");
  } finally {
    output.release();
    await client.stop();
    await peer.close();
  }
});

Deno.test("late zombie failure cannot terminate the replacement session", async () => {
  const peer = await startTestPeer();
  let rejectZombie: ((error: unknown) => void) | undefined;
  let invocations = 0;
  const zombie = new Promise<void>((_resolve, reject) => {
    rejectZombie = reject;
  });
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
        return invocations === 1 ? zombie : undefined;
      },
    },
    capacity: 1,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await acceptTestHandshake(first);
    const zombieStream = createStreamId();
    await openAndStart(first, zombieStream);
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (invocations === 1) resolve();
          else setTimeout(poll, 1);
        };
        poll();
      }),
    );
    await first.transport.close({
      code: 1000,
      reason: "replace_zombie_session",
    });

    const second = await peer.nextConnection();
    const secondHandshake = await acceptTestHandshake(second, {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    await nextControl(second, "heartbeat");
    assertEquals(client.snapshot().occupiedExecutions, 1);

    rejectZombie?.(new Error("late zombie failure"));
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (client.snapshot().occupiedExecutions === 0) resolve();
          else setTimeout(poll, 1);
        };
        poll();
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assertEquals(peer.connectionCount(), 2);
    assertEquals(
      client.snapshot().connectionId,
      secondHandshake.welcome.connectionId,
    );

    const healthyStream = createStreamId();
    await openAndStart(second, healthyStream);
    await second.transport.sendControl(createWorkEndFrame({
      streamId: healthyStream,
    }));
    await nextControl(second, "work.metadata");
    await nextControl(second, "work.end");
    assertEquals(invocations, 2);
    assertEquals(peer.connectionCount(), 2);

    await shutdown(second, secondHandshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("crossed pre-start cancel stays stream-local on a multiplexed worker", async () => {
  const peer = await startTestPeer();
  let finishHealthy: (() => void) | undefined;
  let invocations = 0;
  const healthyGate = new Promise<void>((resolve) => {
    finishHealthy = resolve;
  });
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: {
      echo: () => {
        invocations++;
        return healthyGate;
      },
    },
    capacity: 2,
    reconnectDelay: () => 0,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const healthyStream = createStreamId();
    await openAndStart(connection, healthyStream);
    await connection.transport.sendControl(createWorkEndFrame({
      streamId: healthyStream,
    }));
    await withTimeout(
      new Promise<void>((resolve) => {
        const poll = (): void => {
          if (invocations === 1) resolve();
          else setTimeout(poll, 1);
        };
        poll();
      }),
    );

    const cancelledStream = createStreamId();
    const sendOpen = connection.transport.sendControl(createWorkOpenFrame({
      streamId: cancelledStream,
      workload: "echo",
      metadata: {},
    }));
    const sendCancel = connection.transport.sendControl(createWorkCancelFrame({
      streamId: cancelledStream,
      reason: "caller_cancelled_before_acceptance",
    }));
    await Promise.all([sendOpen, sendCancel]);

    while (true) {
      const message = await nextControl(connection);
      const frame = message.acceptance.frame;
      if (frame.type === "work.cancel" && frame.streamId === cancelledStream) {
        break;
      }
    }
    assertEquals(invocations, 1);
    assertEquals(peer.connectionCount(), 1);
    assertEquals(
      client.snapshot().connectionId,
      handshake.welcome.connectionId,
    );

    finishHealthy?.();
    await nextControl(connection, "work.metadata");
    await nextControl(connection, "work.end");
    assertEquals(client.snapshot().state, "ready");
    assertEquals(peer.connectionCount(), 1);

    await shutdown(connection, handshake.welcome.connectionId);
    assertEquals(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("worker validator exposes the stable crossed-acceptance error", () => {
  const validator = createProtocolOrderValidator({ role: "worker" });
  const connectionId = "crossed-cancel-connection";
  const streamId = createStreamId();
  validator.acceptControl(
    "sent",
    createHelloFrame({
      handshakeId: "crossed-cancel-handshake",
      identity: IDENTITY,
      credential: {
        kind: "registration",
        capability: "crossed-cancel-registration",
      },
      workloads: ["echo"],
      capacity: 2,
    }),
  );
  validator.acceptControl(
    "received",
    createWelcomeFrame({
      connectionId,
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "crossed-cancel-resume",
      resumeExpiresAtMs: Date.now() + 60_000,
    }),
  );
  validator.acceptControl(
    "sent",
    createReadyFrame({
      connectionId,
      capacity: 2,
    }),
  );
  validator.acceptControl(
    "received",
    createReadyAckFrame({ connectionId }),
  );
  validator.acceptControl(
    "received",
    createWorkOpenFrame({
      streamId,
      workload: "echo",
      metadata: {},
    }),
  );
  validator.acceptControl(
    "received",
    createWorkCancelFrame({
      streamId,
      reason: "caller_cancelled_before_acceptance",
    }),
  );

  const error = assertThrows(() =>
    validator.acceptControl(
      "sent",
      createWorkAcceptedFrame({ streamId }),
    )
  );
  assertEquals(
    (error as Error & Readonly<{ code?: string }>).code,
    "post_terminal_frame",
  );
});

function deferredCancellationOutput(): Readonly<{
  body: ReadableStream<Uint8Array>;
  pulling: Promise<void>;
  cancelling: Promise<void>;
  release(): void;
  settled(): boolean;
  cancelCalls(): number;
}> {
  const pulling = Promise.withResolvers<void>();
  const cancelling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settled = false;
  let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      pulling.resolve();
    },
    async cancel() {
      cancelCalls++;
      cancelling.resolve();
      await release.promise;
      settled = true;
    },
  }, { highWaterMark: 0 });
  return Object.freeze({
    body,
    pulling: pulling.promise,
    cancelling: cancelling.promise,
    release: () => release.resolve(),
    settled: () => settled,
    cancelCalls: () => cancelCalls,
  });
}

function waitForSnapshot(predicate: () => boolean): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (predicate()) resolve();
        else setTimeout(poll, 1);
      };
      poll();
    }),
  );
}
