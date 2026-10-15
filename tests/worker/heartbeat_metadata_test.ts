import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import {
  createShutdownFrame,
  WORKER_PROTOCOL_LIMITS,
} from "../../src/protocol/index.ts";
import type {
  WorkerHeartbeatContext,
  WorkerResult,
} from "../../src/worker/index.ts";
import { createProtocolTestWorker as createWorker } from "./protocol_worker.ts";
import {
  acceptTestHandshake,
  nextControl,
  startTestPeer,
  withTimeout,
} from "./test_peer.ts";

const IDENTITY = Object.freeze({
  workerId: "worker-heartbeat",
  attemptId: "attempt-1",
  epoch: 1,
});

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({
    promise,
    resolve: () => resolvePromise?.(),
  });
}

function waitUntil(predicate: () => boolean): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const poll = (): void => {
        if (predicate()) resolve();
        else setTimeout(poll, 2);
      };
      poll();
    }),
  );
}

function assertReconnectExhausted(result: WorkerResult): void {
  assert.deepStrictEqual(result.reason, "reconnect_exhausted");
}

test("worker propagates heartbeat metadata from an immutable status context", async () => {
  const peer = await startTestPeer();
  let context: WorkerHeartbeatContext | undefined;
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
    capacity: 2,
    reconnectDelay: false,
    createHeartbeatMetadata: (next) => {
      context = next;
      assert.ok(Object.isFrozen(next));
      assert.ok(Object.isFrozen(next.identity));
      assertThrows(
        () =>
          Object.assign(next as unknown as Record<string, unknown>, {
            sequence: 99,
          }),
        TypeError,
      );
      assertThrows(
        () =>
          Object.assign(next.identity as unknown as Record<string, unknown>, {
            workerId: "mutated",
          }),
        TypeError,
      );
      return {
        sandbox: {
          dirty: false,
          processes: 0,
        },
      };
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const message = await nextControl(connection, "heartbeat");
    if (message.acceptance.frame.type !== "heartbeat") {
      throw new TypeError("expected heartbeat");
    }
    assert.deepStrictEqual(message.acceptance.frame.metadata, {
      sandbox: {
        dirty: false,
        processes: 0,
      },
    });
    const capturedContext = context;
    if (capturedContext === undefined) {
      throw new TypeError("heartbeat context was not captured");
    }
    assert.deepStrictEqual(capturedContext, {
      identity: IDENTITY,
      connectionId: handshake.welcome.connectionId,
      capacity: 2,
      sequence: 0,
      inflight: 0,
      availableCapacity: 2,
      draining: false,
      signal: capturedContext.signal,
    });
    assert.deepStrictEqual(capturedContext.signal.aborted, false);

    await connection.transport.sendControl(
      createShutdownFrame({
        connectionId: handshake.welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
    assert.deepStrictEqual(capturedContext.signal.aborted, true);
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker heartbeat metadata callback is single-flight and stop aborts a hung call", async () => {
  const peer = await startTestPeer();
  const firstGate = deferred();
  const hungGate = deferred();
  const contexts: WorkerHeartbeatContext[] = [];
  let active = 0;
  let maximumActive = 0;
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
    reconnectDelay: false,
    createHeartbeatMetadata: async (context) => {
      contexts.push(context);
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (context.sequence === 0) await firstGate.promise;
        else await hungGate.promise;
        return { invocation: contexts.length };
      } finally {
        active--;
      }
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection, {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    await waitUntil(() => contexts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepStrictEqual(contexts.length, 1);

    firstGate.resolve();
    await nextControl(connection, "heartbeat");
    await waitUntil(() => contexts.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepStrictEqual(contexts.length, 2);
    assert.deepStrictEqual(maximumActive, 1);
    assert.deepStrictEqual(
      contexts.map(({ sequence }) => sequence),
      [0, 1],
    );

    await withTimeout(client.stop("hung_heartbeat_test"));
    assert.deepStrictEqual(await withTimeout(run), { reason: "stopped" });
    assert.deepStrictEqual(contexts[1]?.signal.aborted, true);
    assert.deepStrictEqual(active, 1);
    hungGate.resolve();
    await waitUntil(() => active === 0);
  } finally {
    firstGate.resolve();
    hungGate.resolve();
    await client.stop();
    await peer.close();
  }
});

test("hung heartbeat metadata does not block remote shutdown", async () => {
  const peer = await startTestPeer();
  const hungGate = deferred();
  let context: WorkerHeartbeatContext | undefined;
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
    reconnectDelay: false,
    createHeartbeatMetadata: async (next) => {
      context = next;
      await hungGate.promise;
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    await waitUntil(() => context !== undefined);
    await connection.transport.sendControl(
      createShutdownFrame({
        connectionId: handshake.welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
    assert.deepStrictEqual(context?.signal.aborted, true);
  } finally {
    hungGate.resolve();
    await client.stop();
    await peer.close();
  }
});

test("worker fail-closes a session when heartbeat metadata creation throws", async () => {
  const peer = await startTestPeer();
  let signal: AbortSignal | undefined;
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
    reconnectDelay: false,
    createHeartbeatMetadata: (context) => {
      signal = context.signal;
      throw new Error("status source failed");
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assert.deepStrictEqual(close.code, 4000);
    assert.deepStrictEqual(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
    assert.deepStrictEqual(signal?.aborted, true);
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker fail-closes a session when heartbeat metadata is not valid JSON", async () => {
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
    reconnectDelay: false,
    createHeartbeatMetadata: () => ({
      load: Number.NaN,
    }),
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assert.deepStrictEqual(close.code, 4000);
    assert.deepStrictEqual(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker fail-closes a session when heartbeat metadata exceeds the control bound", async () => {
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
    reconnectDelay: false,
    createHeartbeatMetadata: () => ({
      status: "x".repeat(WORKER_PROTOCOL_LIMITS.maxControlFrameBytes),
    }),
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assert.deepStrictEqual(close.code, 4000);
    assert.deepStrictEqual(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
  } finally {
    await client.stop();
    await peer.close();
  }
});
