import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../support/assert.ts";
import {
  createProtocolErrorFrame,
  createReadyAckFrame,
  createShutdownFrame,
  createWelcomeFrame,
  type HelloFrame,
  type ReadyFrame,
  WORKER_PROTOCOL,
} from "../../src/protocol/index.ts";
import type { WorkerResumeCredentialUpdate } from "../../src/worker/index.ts";
import {
  createProtocolTestWorker as createWorker,
  type ProtocolTestWorkerOptions as WebSocketWorkerOptions,
} from "./protocol_worker.ts";
import {
  acceptTestHandshake,
  nextControl,
  startTestPeer,
  withTimeout,
} from "./test_peer.ts";

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve(): void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

const IDENTITY = Object.freeze({
  workerId: "worker-1",
  attemptId: "attempt-1",
  epoch: 1,
});

test("worker handshake persists, bootstraps, then advertises Ready metadata", async () => {
  const peer = await startTestPeer();
  const persistGate = deferred();
  const prepareGate = deferred();
  const prepareEntered = deferred();
  const events: string[] = [];
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    handshakeId: "handshake-registration",
    workloads: { echo: () => undefined },
    reconnectDelay: () => 0,
    persistResumeCredential: async () => {
      events.push("persist");
      await persistGate.promise;
    },
    beforeReady: async ({ bootstrap, reconnecting }) => {
      events.push("prepare");
      assert.deepStrictEqual(bootstrap, { revision: "sandbox-r1" });
      assert.deepStrictEqual(reconnecting, false);
      prepareEntered.resolve();
      await prepareGate.promise;
      return { initializedRevision: "sandbox-r1" };
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const hello = (await nextControl(connection, "hello")).acceptance
      .frame as HelloFrame;
    assert.deepStrictEqual(hello.handshakeId, "handshake-registration");
    const welcome = createWelcomeFrame({
      connectionId: "connection-1",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-1",
      resumeExpiresAtMs: Date.now() + 600_000,
      bootstrap: { revision: "sandbox-r1" },
    });
    await connection.transport.sendControl(welcome);

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepStrictEqual(client.snapshot().state, "handshaking");
    assert.deepStrictEqual(events, ["persist"]);

    persistGate.resolve();
    await withTimeout(prepareEntered.promise);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepStrictEqual(client.snapshot().state, "handshaking");

    prepareGate.resolve();
    const ready = (await nextControl(connection, "ready")).acceptance
      .frame as ReadyFrame;
    assert.deepStrictEqual(ready.metadata, {
      initializedRevision: "sandbox-r1",
    });
    assert.deepStrictEqual(events, ["persist", "prepare"]);
    assert.deepStrictEqual(client.snapshot().state, "handshaking");
    await connection.transport.sendControl(
      createReadyAckFrame({
        connectionId: welcome.connectionId,
      }),
    );
    assert.deepStrictEqual((await withTimeout(client.ready)).state, "ready");

    await connection.transport.sendControl(
      createShutdownFrame({
        connectionId: welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker delegates provider authentication to its socket factory", async () => {
  const peer = await startTestPeer();
  let factoryCalls = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
      socket(context) {
        factoryCalls++;
        assert.deepStrictEqual(context.url.href, peer.url);
        assert.deepStrictEqual(context.protocol, WORKER_PROTOCOL);
        assert.deepStrictEqual(context.signal.aborted, false);
        return new WebSocket(context.url, context.protocol);
      },
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    credentialPersistence: "ephemeral",
    workloads: { echo: () => undefined },
    reconnectDelay: false,
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await nextControl(connection, "hello");
    const welcome = createWelcomeFrame({
      connectionId: "connection-authenticated-factory",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-authenticated-factory",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await connection.transport.sendControl(welcome);
    await nextControl(connection, "ready");
    await connection.transport.sendControl(
      createReadyAckFrame({
        connectionId: welcome.connectionId,
      }),
    );
    assert.deepStrictEqual(factoryCalls, 1);
    await connection.transport.sendControl(
      createShutdownFrame({
        connectionId: welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("lost Ready acknowledgement reconnects without reporting a false ready state", async () => {
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
    readyTimeoutMs: 40,
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await nextControl(first, "hello");
    await first.transport.sendControl(
      createWelcomeFrame({
        connectionId: "connection-ready-ack-lost",
        heartbeatIntervalMs: 1_000,
        leaseTimeoutMs: 5_000,
        resumeCapability: "resume-ready-ack-lost",
        resumeExpiresAtMs: Date.now() + 600_000,
      }),
    );
    await nextControl(first, "ready");
    assert.deepStrictEqual(client.snapshot().state, "handshaking");
    await withTimeout(
      first.transport.closed,
      1_000,
      "worker did not abandon the unacknowledged Ready",
    );

    const second = await peer.nextConnection();
    await nextControl(second, "hello");
    const welcome = createWelcomeFrame({
      connectionId: "connection-ready-ack-retry",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-ready-ack-retry",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await second.transport.sendControl(welcome);
    await nextControl(second, "ready");
    assert.deepStrictEqual(client.snapshot().state, "handshaking");
    await second.transport.sendControl(
      createReadyAckFrame({
        connectionId: welcome.connectionId,
      }),
    );
    assert.deepStrictEqual((await withTimeout(client.ready)).state, "ready");

    await second.transport.sendControl(
      createShutdownFrame({
        connectionId: welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker Ready initialization has an independent long-running timeout", async () => {
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
    handshakeTimeoutMs: 20,
    readyTimeoutMs: 250,
    beforeReady: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      return { restored: true };
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await nextControl(connection, "hello");
    const welcome = createWelcomeFrame({
      connectionId: "connection-slow-ready",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-slow-ready",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await connection.transport.sendControl(welcome);
    const ready = (await nextControl(connection, "ready")).acceptance
      .frame as ReadyFrame;
    assert.deepStrictEqual(ready.metadata, { restored: true });
    await connection.transport.sendControl(
      createReadyAckFrame({
        connectionId: welcome.connectionId,
      }),
    );

    await connection.transport.sendControl(
      createShutdownFrame({
        connectionId: welcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("persistence failure retries the exact prior credential and handshake", async () => {
  const peer = await startTestPeer();
  let persistenceAttempt = 0;
  let handshakeSequence = 0;
  const updates: WorkerResumeCredentialUpdate[] = [];
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    handshakeId: "registration-exchange-1",
    workloads: { echo: () => undefined },
    reconnectDelay: () => 0,
    createHandshakeId: () => `resume-exchange-${++handshakeSequence}`,
    persistResumeCredential: (update) => {
      updates.push(update);
      persistenceAttempt++;
      if (persistenceAttempt === 1) {
        throw new Error("disk unavailable");
      }
    },
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    const hello1 = (await nextControl(first, "hello")).acceptance
      .frame as HelloFrame;
    const welcome = createWelcomeFrame({
      connectionId: "connection-1",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-1",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await first.transport.sendControl(welcome);
    await first.transport.closed;

    const second = await peer.nextConnection();
    const hello2 = (await nextControl(second, "hello")).acceptance
      .frame as HelloFrame;
    assert.deepStrictEqual(hello2.credential, hello1.credential);
    assert.deepStrictEqual(hello2.handshakeId, hello1.handshakeId);
    await second.transport.sendControl({
      ...welcome,
      connectionId: "connection-2",
    });
    await nextControl(second, "ready");
    await second.transport.sendControl(
      createReadyAckFrame({
        connectionId: "connection-2",
      }),
    );
    assert.deepStrictEqual(persistenceAttempt, 2);
    assert.deepStrictEqual(handshakeSequence, 1);
    assert.deepStrictEqual(updates[1], updates[0]);
    assert.deepStrictEqual(updates[0]?.replacesHandshakeId, hello1.handshakeId);

    await second.transport.sendControl(
      createShutdownFrame({
        connectionId: "connection-2",
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("revoked resume credential surfaces re-enrollment without reconnecting", async () => {
  const peer = await startTestPeer();
  const notifications: unknown[] = [];
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "resume", capability: "revoked-resume" },
    credentialPersistence: "ephemeral",
    handshakeId: "resume-exchange-1",
    resumeExpiresAtMs: Date.now() + 60_000,
    workloads: { echo: () => undefined },
    reconnectDelay: () => {
      throw new Error("permanent auth failure must not reconnect");
    },
    onReenrollmentRequired: (error) => {
      notifications.push(error);
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await nextControl(connection, "hello");
    await connection.transport.sendControl(
      createProtocolErrorFrame({
        code: "credential_invalid",
        message: "Worker authentication failed",
      }),
    );
    const result = await withTimeout(run);
    assert.deepStrictEqual(result.reason, "reenrollment_required");
    assert.deepStrictEqual(notifications.length, 1);
    await assertRejects(() => peer.nextConnection(75));
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("worker credentials are copied and stored resume expiry is mandatory", async () => {
  const peer = await startTestPeer();
  const mutableCredential = {
    kind: "registration" as const,
    capability: "original-registration",
  };
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: mutableCredential,
    credentialPersistence: "ephemeral",
    handshakeId: "registration-exchange-1",
    workloads: { echo: () => undefined },
    reconnectDelay: false,
  });
  mutableCredential.capability = "mutated-after-construction";
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    const hello = (await nextControl(connection, "hello")).acceptance
      .frame as HelloFrame;
    assert.deepStrictEqual(
      hello.credential.capability,
      "original-registration",
    );
    await connection.transport.close({
      code: 1000,
      reason: "test_complete",
    });
    assert.deepStrictEqual(
      (await withTimeout(run)).reason,
      "reconnect_exhausted",
    );
  } finally {
    await client.stop();
    await peer.close();
  }

  assertThrows(
    () =>
      createWorker({
        transport: {
          type: "websocket",
          url: "wss://example.test/workers",
        },
        identity: IDENTITY,
        credential: { kind: "resume", capability: "resume-1" },
        credentialPersistence: "ephemeral",
        workloads: { echo: () => undefined },
      } as unknown as WebSocketWorkerOptions),
    TypeError,
    "resumeExpiresAtMs",
  );
  assertThrows(
    () =>
      createWorker({
        transport: {
          type: "websocket",
          url: "wss://example.test/workers",
        },
        identity: IDENTITY,
        credential: { kind: "registration", capability: "registration-1" },
        credentialPersistence: "ephemeral",
        workloads: { echo: () => undefined },
        createHandshakeId: () => "not valid spaces",
      }),
    TypeError,
    "handshakeId",
  );
  assertThrows(
    () =>
      createWorker({
        transport: {
          type: "websocket",
          url: "wss://example.test/workers",
        },
        identity: IDENTITY,
        credential: {
          kind: "registration",
          capability: "registration-1",
        },
        workloads: { echo: () => undefined },
      } as unknown as WebSocketWorkerOptions),
    TypeError,
    "persistResumeCredential",
  );
  assertThrows(
    () =>
      createWorker({
        transport: {
          type: "websocket",
          url: "wss://example.test/workers",
        },
        identity: IDENTITY,
        credential: {
          kind: "registration",
          capability: "registration-1",
        },
        credentialPersistence: "ephemeral",
        workloads: { echo: () => undefined },
        readyTimeoutMs: 0,
      }),
    TypeError,
    "readyTimeoutMs",
  );
  assertThrows(
    () =>
      createWorker({
        transport: {
          type: "websocket",
          url: "wss://example.test/workers",
          socket: 42,
        },
        identity: IDENTITY,
        credential: {
          kind: "registration",
          capability: "registration-1",
        },
        credentialPersistence: "ephemeral",
        workloads: { echo: () => undefined },
      } as unknown as WebSocketWorkerOptions),
    TypeError,
    "transport.socket",
  );
});

test("an unsettled pre-ready hook blocks reconnect but not stop", async () => {
  const peer = await startTestPeer();
  const entered = deferred();
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
    handshakeTimeoutMs: 50,
    readyTimeoutMs: 50,
    beforeReady: () => {
      entered.resolve();
      return new Promise(() => undefined);
    },
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await nextControl(first, "hello");
    await first.transport.sendControl(
      createWelcomeFrame({
        connectionId: "connection-hanging",
        heartbeatIntervalMs: 1_000,
        leaseTimeoutMs: 5_000,
        resumeCapability: "resume-after-hang",
        resumeExpiresAtMs: Date.now() + 600_000,
      }),
    );
    await withTimeout(entered.promise);
    await nextControl(first, "protocol_error");
    await first.transport.closed;

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepStrictEqual(peer.connectionCount(), 1);
    await withTimeout(client.stop("test_stop"));
    assert.deepStrictEqual(await withTimeout(run), { reason: "stopped" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("an unsettled durable persister blocks reconnect but not stop", async () => {
  const peer = await startTestPeer();
  const entered = deferred();
  let persistenceSignalAborted = false;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    handshakeId: "registration-exchange-hanging",
    workloads: { echo: () => undefined },
    reconnectDelay: () => 0,
    handshakeTimeoutMs: 50,
    persistResumeCredential: (_update, { signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          persistenceSignalAborted = true;
        },
        { once: true },
      );
      entered.resolve();
      return new Promise(() => undefined);
    },
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await nextControl(first, "hello");
    await first.transport.sendControl(
      createWelcomeFrame({
        connectionId: "connection-persist-hanging",
        heartbeatIntervalMs: 1_000,
        leaseTimeoutMs: 5_000,
        resumeCapability: "resume-not-persisted",
        resumeExpiresAtMs: Date.now() + 600_000,
      }),
    );
    await withTimeout(entered.promise);
    await first.transport.closed;
    assert.deepStrictEqual(persistenceSignalAborted, true);

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepStrictEqual(peer.connectionCount(), 1);
    await withTimeout(client.stop("test_stop"));
    assert.deepStrictEqual(await withTimeout(run), { reason: "stopped" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("late durable completion is adopted before reconnect without overlapping writes", async () => {
  const peer = await startTestPeer();
  const firstPersistence = deferred();
  const firstPersistenceEntered = deferred();
  const updates: WorkerResumeCredentialUpdate[] = [];
  let activePersistence = 0;
  let maximumActivePersistence = 0;
  let handshakeSequence = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: peer.url,
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "registration", capability: "registration-1" },
    handshakeId: "registration-exchange-late",
    workloads: { echo: () => undefined },
    reconnectDelay: () => 0,
    handshakeTimeoutMs: 50,
    createHandshakeId: () => `resume-exchange-${++handshakeSequence}`,
    persistResumeCredential: async (update) => {
      updates.push(update);
      activePersistence++;
      maximumActivePersistence = Math.max(
        maximumActivePersistence,
        activePersistence,
      );
      try {
        if (updates.length === 1) {
          firstPersistenceEntered.resolve();
          await firstPersistence.promise;
        }
      } finally {
        activePersistence--;
      }
    },
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    const firstHello = (await nextControl(first, "hello")).acceptance
      .frame as HelloFrame;
    const firstWelcome = createWelcomeFrame({
      connectionId: "connection-late-1",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-late-1",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await first.transport.sendControl(firstWelcome);
    await withTimeout(firstPersistenceEntered.promise);
    await first.transport.closed;

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepStrictEqual(peer.connectionCount(), 1);
    assert.deepStrictEqual(updates.length, 1);
    assert.deepStrictEqual(
      updates[0]?.replacesHandshakeId,
      firstHello.handshakeId,
    );

    firstPersistence.resolve();
    const second = await peer.nextConnection();
    const secondHello = (await nextControl(second, "hello")).acceptance
      .frame as HelloFrame;
    assert.deepStrictEqual(secondHello.credential, updates[0]?.credential);
    assert.deepStrictEqual(secondHello.handshakeId, updates[0]?.handshakeId);
    assert.deepStrictEqual(updates.length, 1);
    assert.deepStrictEqual(handshakeSequence, 1);

    const secondWelcome = createWelcomeFrame({
      connectionId: "connection-late-2",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-late-2",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await second.transport.sendControl(secondWelcome);
    await nextControl(second, "ready");
    await second.transport.sendControl(
      createReadyAckFrame({
        connectionId: secondWelcome.connectionId,
      }),
    );
    assert.deepStrictEqual(updates.length, 2);
    assert.deepStrictEqual(
      updates[1]?.replacesHandshakeId,
      updates[0]?.handshakeId,
    );
    assert.deepStrictEqual(handshakeSequence, 2);
    assert.deepStrictEqual(maximumActivePersistence, 1);

    await second.transport.sendControl(
      createShutdownFrame({
        connectionId: secondWelcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("late pre-ready completion serializes bootstrap across reconnects", async () => {
  const peer = await startTestPeer();
  const firstInitialization = deferred();
  const firstInitializationEntered = deferred();
  let initializationAttempt = 0;
  let activeInitialization = 0;
  let maximumActiveInitialization = 0;
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
    handshakeTimeoutMs: 50,
    readyTimeoutMs: 50,
    beforeReady: async () => {
      initializationAttempt++;
      const attempt = initializationAttempt;
      activeInitialization++;
      maximumActiveInitialization = Math.max(
        maximumActiveInitialization,
        activeInitialization,
      );
      try {
        if (attempt === 1) {
          firstInitializationEntered.resolve();
          await firstInitialization.promise;
        }
        return { initializationAttempt: attempt };
      } finally {
        activeInitialization--;
      }
    },
  });
  const run = client.closed;

  try {
    const first = await peer.nextConnection();
    await nextControl(first, "hello");
    await first.transport.sendControl(
      createWelcomeFrame({
        connectionId: "connection-initialization-1",
        heartbeatIntervalMs: 1_000,
        leaseTimeoutMs: 5_000,
        resumeCapability: "resume-initialization-1",
        resumeExpiresAtMs: Date.now() + 600_000,
      }),
    );
    await withTimeout(firstInitializationEntered.promise);
    await nextControl(first, "protocol_error");
    await first.transport.closed;

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.deepStrictEqual(peer.connectionCount(), 1);
    assert.deepStrictEqual(initializationAttempt, 1);

    firstInitialization.resolve();
    const second = await peer.nextConnection();
    await nextControl(second, "hello");
    const secondWelcome = createWelcomeFrame({
      connectionId: "connection-initialization-2",
      heartbeatIntervalMs: 1_000,
      leaseTimeoutMs: 5_000,
      resumeCapability: "resume-initialization-2",
      resumeExpiresAtMs: Date.now() + 600_000,
    });
    await second.transport.sendControl(secondWelcome);
    const ready = (await nextControl(second, "ready")).acceptance
      .frame as ReadyFrame;
    assert.deepStrictEqual(ready.metadata, { initializationAttempt: 2 });
    assert.deepStrictEqual(maximumActiveInitialization, 1);
    await second.transport.sendControl(
      createReadyAckFrame({
        connectionId: secondWelcome.connectionId,
      }),
    );

    await second.transport.sendControl(
      createShutdownFrame({
        connectionId: secondWelcome.connectionId,
        reason: "test_complete",
      }),
    );
    assert.deepStrictEqual(await withTimeout(run), { reason: "shutdown" });
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("state observers cannot throw, hang, or reentrantly stop the lifecycle", async () => {
  const peer = await startTestPeer();
  const hungObserverEntered = deferred();
  let observerCalls = 0;
  const client: ReturnType<typeof createWorker> = createWorker({
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
    onStateChange: () => {
      observerCalls++;
      client.snapshot();
      if (observerCalls === 1) {
        throw new Error("observer sync failure");
      }
      hungObserverEntered.resolve();
      void client.stop("observer_reentrant_stop");
      return new Promise<void>(() => undefined);
    },
  });
  const run = client.closed;

  try {
    await withTimeout(hungObserverEntered.promise);
    assert.deepStrictEqual(await withTimeout(run), { reason: "stopped" });
    await withTimeout(client.stop("test_complete"));
    assert.deepStrictEqual(observerCalls, 2);
  } finally {
    await client.stop();
    await peer.close();
  }
});

test("hung re-enrollment notification fires once without gating stop", async () => {
  const notificationEntered = deferred();
  let notifications = 0;
  const client = createWorker({
    transport: {
      type: "websocket",
      url: "ws://127.0.0.1:1/workers",
      allowInsecureLoopback: true,
    },
    identity: IDENTITY,
    credential: { kind: "resume", capability: "expired-resume" },
    credentialPersistence: "ephemeral",
    handshakeId: "expired-resume-handshake",
    resumeExpiresAtMs: Date.now() - 1,
    workloads: { echo: () => undefined },
    reconnectDelay: false,
    onReenrollmentRequired: () => {
      notifications++;
      notificationEntered.resolve();
      return new Promise<void>(() => undefined);
    },
  });

  const result = await withTimeout(client.closed);
  assert.deepStrictEqual(result.reason, "reenrollment_required");
  await withTimeout(notificationEntered.promise);
  await withTimeout(client.stop("test_complete"));
  await withTimeout(client.stop("test_complete_again"));
  assert.deepStrictEqual(notifications, 1);
});

test("hung reconnect delay is single-flight and cannot gate stop", async () => {
  const peer = await startTestPeer();
  const delayEntered = deferred();
  let delayCalls = 0;
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
    reconnectDelay: () => {
      delayCalls++;
      delayEntered.resolve();
      return new Promise<number | null>(() => undefined);
    },
  });
  const run = client.closed;

  try {
    const connection = await peer.nextConnection();
    await acceptTestHandshake(connection);
    await connection.transport.close({
      code: 1000,
      reason: "exercise_reconnect_delay",
    });
    await withTimeout(delayEntered.promise);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepStrictEqual(delayCalls, 1);
    assert.deepStrictEqual(peer.connectionCount(), 1);
    await withTimeout(client.stop("test_complete"));
    assert.deepStrictEqual(await withTimeout(run), { reason: "stopped" });
    assert.deepStrictEqual(delayCalls, 1);
  } finally {
    await client.stop();
    await peer.close();
  }
});
