import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  createShutdownFrame,
  WORKER_PROTOCOL_LIMITS,
} from "../../src/protocol/index.ts";
import {
  createWorkerClient,
  type WorkerClientResult,
  type WorkerHeartbeatContext,
} from "../../src/worker/index.ts";
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

function assertReconnectExhausted(result: WorkerClientResult): void {
  assertEquals(result.reason, "reconnect_exhausted");
}

Deno.test("worker propagates heartbeat metadata from an immutable status context", async () => {
  const peer = await startTestPeer();
  let context: WorkerHeartbeatContext | undefined;
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    capacity: 2,
    allowInsecureLoopback: true,
    reconnectDelay: false,
    createHeartbeatMetadata: (next) => {
      context = next;
      assert(Object.isFrozen(next));
      assert(Object.isFrozen(next.identity));
      assertThrows(
        () =>
          Object.assign(next as unknown as Record<string, unknown>, {
            sequence: 99,
          }),
        TypeError,
      );
      assertThrows(
        () =>
          Object.assign(
            next.identity as unknown as Record<string, unknown>,
            { workerId: "mutated" },
          ),
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
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    const message = await nextControl(connection, "heartbeat");
    if (message.acceptance.frame.type !== "heartbeat") {
      throw new TypeError("expected heartbeat");
    }
    assertEquals(message.acceptance.frame.metadata, {
      sandbox: {
        dirty: false,
        processes: 0,
      },
    });
    const capturedContext = context;
    if (capturedContext === undefined) {
      throw new TypeError("heartbeat context was not captured");
    }
    assertEquals(capturedContext, {
      identity: IDENTITY,
      connectionId: handshake.welcome.connectionId,
      capacity: 2,
      sequence: 0,
      inflight: 0,
      availableCapacity: 2,
      draining: false,
      signal: capturedContext.signal,
    });
    assertEquals(capturedContext.signal.aborted, false);

    await connection.transport.sendControl(createShutdownFrame({
      connectionId: handshake.welcome.connectionId,
      reason: "test_complete",
    }));
    assertEquals(await withTimeout(run), { reason: "shutdown" });
    assertEquals(capturedContext.signal.aborted, true);
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("worker heartbeat metadata callback is single-flight and stop aborts a hung call", async () => {
  const peer = await startTestPeer();
  const firstGate = deferred();
  const hungGate = deferred();
  const contexts: WorkerHeartbeatContext[] = [];
  let active = 0;
  let maximumActive = 0;
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    allowInsecureLoopback: true,
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
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection, {
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 100,
    });
    await waitUntil(() => contexts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assertEquals(contexts.length, 1);

    firstGate.resolve();
    await nextControl(connection, "heartbeat");
    await waitUntil(() => contexts.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assertEquals(contexts.length, 2);
    assertEquals(maximumActive, 1);
    assertEquals(contexts.map(({ sequence }) => sequence), [0, 1]);

    await withTimeout(client.stop("hung_heartbeat_test"));
    assertEquals(await withTimeout(run), { reason: "stopped" });
    assertEquals(contexts[1]?.signal.aborted, true);
    assertEquals(active, 1);
    hungGate.resolve();
    await waitUntil(() => active === 0);
  } finally {
    firstGate.resolve();
    hungGate.resolve();
    await client.stop();
    await peer.close();
  }
});

Deno.test("hung heartbeat metadata does not block remote shutdown", async () => {
  const peer = await startTestPeer();
  const hungGate = deferred();
  let context: WorkerHeartbeatContext | undefined;
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    allowInsecureLoopback: true,
    reconnectDelay: false,
    createHeartbeatMetadata: async (next) => {
      context = next;
      await hungGate.promise;
    },
  });
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    const handshake = await acceptTestHandshake(connection);
    await waitUntil(() => context !== undefined);
    await connection.transport.sendControl(createShutdownFrame({
      connectionId: handshake.welcome.connectionId,
      reason: "test_complete",
    }));
    assertEquals(await withTimeout(run), { reason: "shutdown" });
    assertEquals(context?.signal.aborted, true);
  } finally {
    hungGate.resolve();
    await client.stop();
    await peer.close();
  }
});

Deno.test("worker fail-closes a session when heartbeat metadata creation throws", async () => {
  const peer = await startTestPeer();
  let signal: AbortSignal | undefined;
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    allowInsecureLoopback: true,
    reconnectDelay: false,
    createHeartbeatMetadata: (context) => {
      signal = context.signal;
      throw new Error("status source failed");
    },
  });
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assertEquals(close.code, 4000);
    assertEquals(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
    assertEquals(signal?.aborted, true);
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("worker fail-closes a session when heartbeat metadata is not valid JSON", async () => {
  const peer = await startTestPeer();
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    allowInsecureLoopback: true,
    reconnectDelay: false,
    createHeartbeatMetadata: () => ({
      load: Number.NaN,
    }),
  });
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assertEquals(close.code, 4000);
    assertEquals(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
  } finally {
    await client.stop();
    await peer.close();
  }
});

Deno.test("worker fail-closes a session when heartbeat metadata exceeds the control bound", async () => {
  const peer = await startTestPeer();
  const client = createWorkerClient({
    url: peer.url,
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    allowInsecureLoopback: true,
    reconnectDelay: false,
    createHeartbeatMetadata: () => ({
      status: "x".repeat(WORKER_PROTOCOL_LIMITS.maxControlFrameBytes),
    }),
  });
  const run = client.run();

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    const close = await withTimeout(connection.transport.closed);
    assertEquals(close.code, 4000);
    assertEquals(close.reason, "worker_session_failed");
    assertReconnectExhausted(await withTimeout(run));
  } finally {
    await client.stop();
    await peer.close();
  }
});
