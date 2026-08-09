import { assert, assertEquals, assertRejects } from "@std/assert";
import { serve } from "../../src/adapters/deno/index.ts";
import type {
  Hypervisor,
  HypervisorDisconnectEvent,
  HypervisorHeartbeatContext,
  HypervisorListener,
  HypervisorReadyContext,
} from "../../src/hypervisor/index.ts";
import {
  createProtocolTestHypervisor as createHypervisor,
  type SessionLifecycleCallbacks,
  TEST_WORKER_PATH,
} from "./protocol_hypervisor.ts";
import {
  createHeartbeatFrame,
  createHelloFrame,
  createReadyFrame,
  type JsonObject,
  type WelcomeFrame,
  type WorkerCredential,
  type WorkerIdentity,
} from "../../src/protocol/index.ts";
import {
  createEphemeralCredentialLifecycle,
  createEphemeralWorkerStore,
  createWorkerDefinition,
  type CredentialLifecycle,
  type RegistrationGrant,
  type WorkerDefinition,
} from "../../src/supervisor/index.ts";
import {
  adaptSocketConnection,
  connectWorkerWebSocket,
  createFrameConnection,
  createProtocolTransport,
  type ProtocolTransport,
  type ProtocolTransportMessage,
} from "../../src/transport/index.ts";
import { nextControlledControl } from "./controlled_worker.ts";

const TEST_TIMEOUT_MS = 5_000;
const CAPACITY = 4;
const WORKLOAD = "sandbox.command";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

type LifecycleWorker = Readonly<{
  transport: ProtocolTransport;
  iterator: AsyncIterator<ProtocolTransportMessage>;
  welcome: WelcomeFrame;
  close(reason?: string): Promise<void>;
}>;

type LifecycleHarness = Readonly<{
  hypervisor: Hypervisor;
  listener: HypervisorListener;
  definition: WorkerDefinition;
  identity: WorkerIdentity;
  registration: RegistrationGrant;
  connect(
    input: Readonly<{
      credential: WorkerCredential;
      handshakeId: string;
      metadata?: JsonObject;
      sendReady?: boolean;
    }>,
  ): Promise<LifecycleWorker>;
  close(): Promise<void>;
}>;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DOMException(message, "TimeoutError")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new DOMException(message, "TimeoutError");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function workerUrl(listener: HypervisorListener, path: string): URL {
  const url = new URL(path, listener.url);
  url.protocol = "ws:";
  return url;
}

async function createLifecycleHarness(
  sessionCallbacks: SessionLifecycleCallbacks,
  options: Readonly<{
    clock?: () => number;
    wrapAuthority?: (
      authority: CredentialLifecycle,
    ) => CredentialLifecycle;
  }> = {},
): Promise<LifecycleHarness> {
  const repository = createEphemeralWorkerStore({
    clock: options.clock,
  });
  const definition = await repository.define(createWorkerDefinition({
    workerId: "session-lifecycle-worker",
    providerId: "externally-attached",
    workloads: [WORKLOAD],
    capacity: CAPACITY,
    providerConfig: { pool: "lifecycle-test" },
    labels: { region: "local" },
  }));
  const identity = (await repository.activate(definition.workerId)).attempt
    .identity;
  const registrationAuthority = createEphemeralCredentialLifecycle({
    clock: options.clock,
  });
  const registration = await registrationAuthority.issueRegistration(identity);
  const authority = options.wrapAuthority?.(registrationAuthority) ??
    registrationAuthority;
  const hypervisor = createHypervisor({
    control: { authority, repository },
    commitAcceptedWork: () => Promise.resolve(),
    sessionCallbacks,
    clock: options.clock,
    config: {
      heartbeatIntervalMs: 100,
      leaseTimeoutMs: 2_000,
      leaseSweepIntervalMs: 50,
      readyTimeoutMs: 2_000,
      shutdownTimeoutMs: 100,
      cancellationAckTimeoutMs: 250,
      maxConnectionAgeMs: 60_000,
      proactiveDrainMarginMs: 1_000,
    },
  });
  const listener = serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const url = workerUrl(listener, TEST_WORKER_PATH);
  const workers = new Set<LifecycleWorker>();

  const connect: LifecycleHarness["connect"] = async (input) => {
    const socket = await connectWorkerWebSocket({
      url,
      allowInsecureLoopback: true,
      timeoutMs: 1_000,
    });
    const connection = await createFrameConnection(
      adaptSocketConnection(socket),
    );
    const transport = await createProtocolTransport({
      connection,
      role: "worker",
    });
    const iterator = transport.messages()[Symbol.asyncIterator]();
    try {
      await transport.sendControl(createHelloFrame({
        handshakeId: input.handshakeId,
        identity,
        credential: input.credential,
        workloads: [WORKLOAD],
        capacity: CAPACITY,
      }));
      const welcome = await nextControlledControl(
        { iterator },
        "welcome",
      );
      if (input.sendReady !== false) {
        await transport.sendControl(createReadyFrame({
          connectionId: welcome.connectionId,
          capacity: CAPACITY,
          metadata: input.metadata ?? {},
        }));
      }
      let closed = false;
      const worker: LifecycleWorker = Object.freeze({
        transport,
        iterator,
        welcome,
        close: async (reason = "lifecycle_worker_closed") => {
          if (closed) return;
          closed = true;
          await transport.close({
            code: 4100,
            reason,
            timeoutMs: 250,
          }).catch(() => undefined);
        },
      });
      workers.add(worker);
      return worker;
    } catch (error) {
      await transport.close({
        code: 4100,
        reason: "lifecycle_worker_setup_failed",
        timeoutMs: 250,
      }).catch(() => undefined);
      throw error;
    }
  };

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await Promise.all([...workers].map((worker) => worker.close()));
      await hypervisor.shutdown("lifecycle_test_cleanup").catch(() =>
        undefined
      );
      await listener.shutdown().catch(() => undefined);
    })();
    return closing;
  };

  return Object.freeze({
    hypervisor,
    listener,
    definition,
    identity,
    registration,
    connect,
    close,
  });
}

Deno.test({
  name: "session lifecycle Ready commit gates process-local routability",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const entered = createDeferred<HypervisorReadyContext>();
    const release = createDeferred<void>();
    const metadata = { environment: "local", status: { booted: true } };
    const harness = await createLifecycleHarness({
      onReady(context) {
        entered.resolve(context);
        return release.promise;
      },
      onHeartbeat() {},
      onDisconnect() {},
    });
    let worker: LifecycleWorker | undefined;
    try {
      worker = await harness.connect({
        credential: harness.registration.credential,
        handshakeId: "ready-gate-handshake",
        metadata,
      });
      const context = await withTimeout(
        entered.promise,
        "Ready commit was not invoked",
      );
      assertEquals(context.fence.identity, harness.identity);
      assertEquals(
        context.fence.connectionId,
        worker.welcome.connectionId,
      );
      assertEquals(context.fence.sessionGeneration, 1);
      assertEquals(context.definition, harness.definition);
      assertEquals(context.metadata, metadata);
      assert(!context.signal.aborted);
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)?.phase,
        "connected",
      );
      await assertRejects(
        () => harness.hypervisor.dispatch({ workload: WORKLOAD }),
        Error,
        "no ready Worker has capacity",
      );

      release.resolve();
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)?.phase ===
            "ready",
        "Ready commit did not publish the session",
      );
      await nextControlledControl(worker, "ready_ack");
      const handle = await harness.hypervisor.dispatch({ workload: WORKLOAD });
      const open = await nextControlledControl(worker, "work.open");
      assertEquals(open.streamId, handle.streamId);
      await worker.close("ready_routability_proven");
      assertEquals(
        (await withTimeout(handle.completed, "work did not settle")).status,
        "reschedulable",
      );
    } finally {
      release.resolve();
      await worker?.close().catch(() => undefined);
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "snapshot retains an unsettled admission operation after its connection closes",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const exchangeEntered = createDeferred<void>();
    const releaseExchange = createDeferred<void>();
    const harness = await createLifecycleHarness({
      onReady() {},
      onHeartbeat() {},
      onDisconnect() {},
    }, {
      wrapAuthority(authority) {
        return Object.freeze({
          issueRegistration: authority.issueRegistration,
          revoke: authority.revoke,
          async exchange(input) {
            exchangeEntered.resolve();
            await releaseExchange.promise;
            return await authority.exchange(input);
          },
        });
      },
    });
    const connecting = harness.connect({
      credential: harness.registration.credential,
      handshakeId: "hanging-authority-exchange",
    });
    try {
      await withTimeout(
        exchangeEntered.promise,
        "registration exchange was not entered",
      );
      const connected = harness.hypervisor.snapshot();
      assertEquals(connected.connections, 1);
      assertEquals(connected.unauthenticatedConnections, 1);
      assertEquals(connected.authenticatedConnections, 0);
      assertEquals(connected.handshakeOperations, 1);
      assertEquals(connected.readyOperations, 0);

      await withTimeout(
        harness.hypervisor.shutdown("close_hanging_exchange"),
        "Hypervisor shutdown waited for the external exchange",
      );
      await withTimeout(
        connecting.then(
          () => {
            throw new Error("closed handshake unexpectedly connected");
          },
          () => undefined,
        ),
        "closed handshake did not reject",
      );
      const closed = harness.hypervisor.snapshot();
      assertEquals(closed.connections, 0);
      assertEquals(closed.unauthenticatedConnections, 1);
      assertEquals(closed.authenticatedConnections, 0);
      assertEquals(closed.handshakeOperations, 1);
      assertEquals(closed.readyOperations, 0);

      releaseExchange.resolve();
      await waitFor(
        () => {
          const snapshot = harness.hypervisor.snapshot();
          return snapshot.unauthenticatedConnections === 0 &&
            snapshot.authenticatedConnections === 0 &&
            snapshot.handshakeOperations === 0;
        },
        "settled exchange did not release retained admission",
      );
    } finally {
      releaseExchange.resolve();
      await connecting.catch(() => undefined);
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "late Ready completion from a replaced generation cannot publish or detach the newer session",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const oldEntered = createDeferred<HypervisorReadyContext>();
    const releaseOld = createDeferred<void>();
    const disconnects: HypervisorDisconnectEvent[] = [];
    const harness = await createLifecycleHarness({
      onReady(context) {
        if (context.fence.sessionGeneration === 1) {
          oldEntered.resolve(context);
          return releaseOld.promise;
        }
      },
      onHeartbeat() {},
      onDisconnect(event) {
        disconnects.push(event);
      },
    });
    try {
      const oldWorker = await harness.connect({
        credential: harness.registration.credential,
        handshakeId: "replacement-old-handshake",
      });
      const oldContext = await withTimeout(
        oldEntered.promise,
        "old Ready commit was not invoked",
      );
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)?.phase,
        "connected",
      );

      const replacement = await harness.connect({
        credential: {
          kind: "resume",
          capability: oldWorker.welcome.resumeCapability,
        },
        handshakeId: "replacement-new-handshake",
      });
      await waitFor(
        () => {
          const session = harness.hypervisor.sessions.get(
            harness.identity.workerId,
          );
          return session?.connectionId === replacement.welcome.connectionId &&
            session.phase === "ready";
        },
        "replacement did not become ready",
      );
      await withTimeout(
        oldWorker.transport.closed,
        "old worker was not fenced",
      );
      assert(oldContext.signal.aborted);

      releaseOld.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      const current = harness.hypervisor.sessions.get(
        harness.identity.workerId,
      );
      assertEquals(current?.connectionId, replacement.welcome.connectionId);
      assertEquals(current?.sessionGeneration, 2);
      assertEquals(current?.phase, "ready");
      assertEquals(
        harness.hypervisor.sessions.detach(oldContext.fence),
        undefined,
      );
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId)
          ?.connectionId,
        replacement.welcome.connectionId,
      );
      assertEquals(
        disconnects.filter((event) =>
          event.fence.connectionId === oldWorker.welcome.connectionId
        ).map((event) => [event.phase, event.reason]),
        [["connected", "session_replaced"]],
      );
    } finally {
      releaseOld.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "heartbeat commit gates lease mutation and rejection fail-closes the session",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    let nowMs = 1_000;
    const heartbeatEntered = createDeferred<
      HypervisorHeartbeatContext
    >();
    const releaseHeartbeat = createDeferred<void>();
    const heartbeatContexts: HypervisorHeartbeatContext[] = [];
    const disconnects: HypervisorDisconnectEvent[] = [];
    const harness = await createLifecycleHarness({
      onReady() {},
      onHeartbeat(context) {
        heartbeatContexts.push(context);
        if (context.sequence === 0) {
          heartbeatEntered.resolve(context);
          return releaseHeartbeat.promise;
        }
        return Promise.reject(new Error("heartbeat persistence failed"));
      },
      onDisconnect(event) {
        disconnects.push(event);
      },
    }, { clock: () => nowMs });
    try {
      const worker = await harness.connect({
        credential: harness.registration.credential,
        handshakeId: "heartbeat-handshake",
      });
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)?.phase ===
            "ready",
        "heartbeat worker did not become ready",
      );
      await nextControlledControl(worker, "ready_ack");
      const before = harness.hypervisor.sessions.get(
        harness.identity.workerId,
      )!;
      nowMs = 1_500;
      await worker.transport.sendControl(createHeartbeatFrame({
        connectionId: worker.welcome.connectionId,
        sequence: 0,
        inflight: 1,
        availableCapacity: 3,
        metadata: { cpuPercent: 25, state: "healthy" },
      }));
      const context = await withTimeout(
        heartbeatEntered.promise,
        "heartbeat commit was not invoked",
      );
      assertEquals(context.fence.identity, harness.identity);
      assertEquals(context.definition, harness.definition);
      assertEquals(context.sequence, 0);
      assertEquals(context.inflight, 1);
      assertEquals(context.availableCapacity, 3);
      assertEquals(context.metadata, {
        cpuPercent: 25,
        state: "healthy",
      });
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId),
        before,
      );

      releaseHeartbeat.resolve();
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)
            ?.nextHeartbeatSequence === 1,
        "durable heartbeat did not update the local lease",
      );
      const after = harness.hypervisor.sessions.get(
        harness.identity.workerId,
      )!;
      assertEquals(after.lastHeartbeatAtMs, 1_500);
      assertEquals(after.leaseExpiresAtMs, 3_500);

      await worker.transport.sendControl(createHeartbeatFrame({
        connectionId: worker.welcome.connectionId,
        sequence: 1,
        inflight: 0,
        availableCapacity: 4,
        metadata: { state: "will-fail" },
      }));
      await withTimeout(
        worker.transport.closed,
        "failed heartbeat did not close the connection",
      );
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId) ===
            undefined,
        "failed heartbeat left a routable session",
      );
      assertEquals(heartbeatContexts.length, 2);
      assertEquals(
        disconnects.map((event) => [event.phase, event.reason]),
        [["ready", "connection_failed"]],
      );
    } finally {
      releaseHeartbeat.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "a monotonic disconnect tombstone prevents a late Ready commit from resurrecting durable presence",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const readyEntered = createDeferred<HypervisorReadyContext>();
    const releaseReady = createDeferred<void>();
    const lateReadySettled = createDeferred<void>();
    const disconnectObserved = createDeferred<HypervisorDisconnectEvent>();
    const disconnectedFences = new Set<string>();
    const disconnects: HypervisorDisconnectEvent[] = [];
    let durableState: "starting" | "ready" | "disconnected" = "starting";
    const fenceKey = (
      fence: HypervisorReadyContext["fence"],
    ): string =>
      [
        fence.identity.workerId,
        fence.identity.attemptId,
        fence.identity.epoch,
        fence.sessionGeneration,
        fence.connectionId,
      ].join("/");
    const harness = await createLifecycleHarness({
      onReady(context) {
        readyEntered.resolve(context);
        return releaseReady.promise.then(() => {
          if (!disconnectedFences.has(fenceKey(context.fence))) {
            durableState = "ready";
          }
          lateReadySettled.resolve();
        });
      },
      onHeartbeat() {},
      onDisconnect(event) {
        disconnectedFences.add(fenceKey(event.fence));
        durableState = "disconnected";
        disconnects.push(event);
        disconnectObserved.resolve(event);
      },
    });
    try {
      const worker = await harness.connect({
        credential: harness.registration.credential,
        handshakeId: "late-ready-disconnect",
      });
      const readyContext = await withTimeout(
        readyEntered.promise,
        "Ready commit was not entered",
      );

      // This text deliberately resembles a trusted local lifecycle reason.
      // It must remain diagnostic peer data only.
      await worker.close("shutdown");
      await withTimeout(
        disconnectObserved.promise,
        "peer close did not promptly abort the pending Ready commit",
        750,
      );
      await waitFor(
        () => disconnects.length === 1,
        "disconnect was not observed while Ready remained pending",
      );
      assert(readyContext.signal.aborted);
      assertEquals(durableState, "disconnected");
      assertEquals(disconnects[0].reason, "peer_closed");
      assertEquals(disconnects[0].peerClose?.reason, "shutdown");
      const pendingAdmission = harness.hypervisor.snapshot();
      assertEquals(pendingAdmission.connections, 0);
      assertEquals(pendingAdmission.unauthenticatedConnections, 0);
      assertEquals(pendingAdmission.authenticatedConnections, 1);
      assertEquals(pendingAdmission.handshakeOperations, 0);
      assertEquals(pendingAdmission.readyOperations, 1);

      releaseReady.resolve();
      await withTimeout(
        lateReadySettled.promise,
        "late Ready adapter task did not settle",
      );
      await waitFor(
        () => {
          const snapshot = harness.hypervisor.snapshot();
          return snapshot.authenticatedConnections === 0 &&
            snapshot.readyOperations === 0;
        },
        "settled Ready adapter did not release retained admission",
      );
      assertEquals(durableState, "disconnected");
      assertEquals(disconnects.length, 1);
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId),
        undefined,
      );
    } finally {
      releaseReady.resolve();
      await harness.close();
    }
  },
});

Deno.test({
  name:
    "disconnect observer fires once for pre-ready, replacement, and shutdown without owning cleanup",
  permissions: { net: ["127.0.0.1"] },
  async fn() {
    const disconnects: HypervisorDisconnectEvent[] = [];
    const harness = await createLifecycleHarness({
      onReady() {},
      onHeartbeat() {},
      onDisconnect(event) {
        disconnects.push(event);
        if (disconnects.length === 1) {
          throw new Error("synchronous observer failure");
        }
        return Promise.reject(new Error("asynchronous observer failure"));
      },
    }, { clock: () => 10_000 });
    try {
      const preReady = await harness.connect({
        credential: harness.registration.credential,
        handshakeId: "disconnect-pre-ready",
        sendReady: false,
      });
      await preReady.close("pre_ready_departure");
      await waitFor(
        () => disconnects.length === 1,
        "pre-ready disconnect was not observed",
      );
      assertEquals(harness.hypervisor.snapshot().connections, 0);

      const current = await harness.connect({
        credential: {
          kind: "resume",
          capability: preReady.welcome.resumeCapability,
        },
        handshakeId: "disconnect-current",
      });
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)?.phase ===
            "ready",
        "current worker did not become ready",
      );
      const replacement = await harness.connect({
        credential: {
          kind: "resume",
          capability: current.welcome.resumeCapability,
        },
        handshakeId: "disconnect-replacement",
      });
      await waitFor(
        () =>
          harness.hypervisor.sessions.get(harness.identity.workerId)
              ?.connectionId === replacement.welcome.connectionId &&
          disconnects.length === 2,
        "replacement disconnect was not observed",
      );

      await withTimeout(
        harness.hypervisor.shutdown("requested_shutdown"),
        "shutdown was blocked by disconnect observer",
      );
      await waitFor(
        () => disconnects.length === 3,
        "shutdown disconnect was not observed",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assertEquals(disconnects.length, 3);
      assertEquals(disconnects[0].reason, "peer_closed");
      assertEquals(disconnects[0].peerClose?.code, 4100);
      assertEquals(
        disconnects[0].peerClose?.reason,
        "pre_ready_departure",
      );
      assertEquals(
        typeof disconnects[0].peerClose?.wasClean,
        "boolean",
      );
      assertEquals(disconnects[1].peerClose, undefined);
      assertEquals(disconnects[2].peerClose, undefined);
      assertEquals(
        disconnects.map((event) => ({
          connectionId: event.fence.connectionId,
          identity: event.fence.identity,
          definition: event.definition,
          phase: event.phase,
          reason: event.reason,
          disconnectedAtMs: event.disconnectedAtMs,
        })),
        [
          {
            connectionId: preReady.welcome.connectionId,
            identity: harness.identity,
            definition: harness.definition,
            phase: "authenticated",
            reason: "peer_closed",
            disconnectedAtMs: 10_000,
          },
          {
            connectionId: current.welcome.connectionId,
            identity: harness.identity,
            definition: harness.definition,
            phase: "ready",
            reason: "session_replaced",
            disconnectedAtMs: 10_000,
          },
          {
            connectionId: replacement.welcome.connectionId,
            identity: harness.identity,
            definition: harness.definition,
            phase: "draining",
            reason: "shutdown",
            disconnectedAtMs: 10_000,
          },
        ],
      );
      assertEquals(harness.hypervisor.snapshot().connections, 0);
      assertEquals(
        harness.hypervisor.sessions.get(harness.identity.workerId),
        undefined,
      );
    } finally {
      await harness.close();
    }
  },
});
