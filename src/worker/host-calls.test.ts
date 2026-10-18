import assert from "node:assert/strict";
import { test } from "node:test";
import { createHypervisor } from "../hypervisor/hypervisor.ts";
import type { WorkerCallOptions, Hypervisor } from "../hypervisor/types.ts";
import { serve } from "../adapters/node/server.ts";
import { createWorker } from "./worker.ts";
import type { WorkerWorkHandler, Worker } from "./types.ts";
import { isHostCallError, type HostCallHandle } from "../work/host-call.ts";
import type { WorkerTransport } from "../transport/declarations.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function latch<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function text(call: HostCallHandle): Promise<string> {
  const result = await new Response(call.output).text();
  await call.completed;
  return result;
}
async function fixture(
  kind: "in-process" | "websocket",
  calls: WorkerCallOptions | undefined,
  handler: WorkerWorkHandler,
  configureHostCalls = true,
  maxLifetimeStreams?: number,
) {
  const local = {
    type: "in-process" as const,
    config: { topic: crypto.randomUUID() },
  };
  const identity = {
    workerId: "trusted-worker",
    attemptId: crypto.randomUUID(),
    epoch: 7,
  };
  let generation = 0;
  const h = createHypervisor({
    transports:
      kind === "in-process"
        ? [local]
        : [{ type: "websocket", config: { path: "/workers" } }],
    workerCalls: calls,
    config: {
      ...(maxLifetimeStreams === undefined ? {} : { maxLifetimeStreams }),
      shutdownTimeoutMs: maxLifetimeStreams === undefined ? 100 : 1000,
      cancellationAckTimeoutMs: 100,
      heartbeatIntervalMs: 20,
      leaseTimeoutMs: 1000,
      leaseSweepIntervalMs: 100,
    },
    admit: ({ identity: received, credential }) => {
      assert.deepEqual(received, identity);
      return {
        definition: {
          workerId: identity.workerId,
          providerId: "test",
          workloads: ["action"],
          capacity: 1,
          providerConfig: {},
          labels: { grant: "host-admitted" },
        },
        sessionGeneration: ++generation,
        authenticatedWith: credential.kind,
        resume: {
          credential: { kind: "resume", capability: "resume-test" },
          expiresAtMs: Date.now() + 60_000,
        },
        bootstrap: { untouched: { nested: "value" } },
      };
    },
  });
  const listener =
    kind === "websocket" ? await serve({ hypervisor: h }) : undefined;
  const url = listener ? new URL("/workers", listener.url) : undefined;
  if (url) url.protocol = "ws:";
  const transport: WorkerTransport = url
    ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
    : local;
  const workers: Worker[] = [];
  const connect = async () => {
    const worker = createWorker({
      id: identity.workerId,
      transport,
      capacity: 1,
      hostCalls: configureHostCalls
        ? { maxConcurrent: 4, timeoutMs: 500 }
        : undefined,
      activate: () => identity,
      register: () => ({
        credential: { kind: "registration", capability: "registration-test" },
        expiresAtMs: Date.now() + 60_000,
      }),
      handshake: (context) => {
        assert.deepEqual(context.bootstrap, { untouched: { nested: "value" } });
      },
      reconnectDelay: false,
      workloads: { action: handler },
    });
    workers.push(worker);
    await worker.ready;
    return worker;
  };
  const worker = await connect();
  return {
    h,
    worker,
    connect,
    async close() {
      await Promise.all(workers.map((worker) => worker.stop()));
      await h.shutdown();
      await listener?.shutdown();
    },
  };
}
async function invoke(h: Hypervisor, metadata = {}) {
  const handle = await h.dispatch({
    workload: "action",
    metadata,
    deadlineAtMs: Date.now() + 2000,
  });
  const result = await new Response(handle.output).text();
  assert.equal((await handle.completed).status, "completed");
  return result;
}

for (const kind of ["in-process", "websocket"] as const) {
  for (const cancel of ["handle", "output"] as const) {
    test(`${kind}: completed reverse ${cancel} cancellation preserves its parent and connection`, {
      timeout: 10_000,
    }, async () => {
      const f = await fixture(
        kind,
        {
          admit: () => () => bytes("application-refused"),
        },
        async ({ callHost }) => {
          const signal = new AbortController();
          const call = await callHost({
            workload: "owner",
            signal: signal.signal,
          });
          await call.completed;
          if (cancel === "handle") {
            await call.cancel();
            await call.cancel();
            assert.equal(
              await new Response(call.output).text(),
              "application-refused",
            );
          } else await call.output.cancel();
          signal.abort();
          await call.completed;
          // Keep the parent occupied through another call, so a poisoned socket
          // cannot be hidden by a parent that happened to finish first.
          assert.equal(
            await text(await callHost({ workload: "owner" })),
            "application-refused",
          );
          return bytes("handled");
        },
      );
      try {
        const before = f.h.sessions.get("trusted-worker")!.connectionId;
        assert.equal(await invoke(f.h), "handled");
        assert.equal(await invoke(f.h), "handled");
        assert.equal(f.h.sessions.get("trusted-worker")!.connectionId, before);
      } finally {
        await f.close();
      }
    });
  }

  test(`${kind}: reverse streams preserve host assignment authority and bounded byte flow`, {
    timeout: 10_000,
  }, async () => {
    const payload = new Uint8Array(2 * 1024 * 1024 + 17).fill(42);
    const f = await fixture(
      kind,
      {
        admit(context) {
          assert.equal(context.fence.identity.workerId, "trusted-worker");
          assert.equal(context.fence.identity.epoch, 7);
          assert.ok(context.fence.sessionGeneration >= 1);
          assert.equal(context.definition.labels.grant, "host-admitted");
          assert.notEqual(
            context.metadata.owner,
            context.parent?.metadata.owner,
          );
          assert.equal(context.parent?.workload, "action");
          return ({ input }) => ({
            metadata: { owner: context.parent!.metadata.owner },
            body: input,
          });
        },
      },
      async ({ callHost }) => {
        const call = await callHost({
          workload: "owner.commands",
          metadata: { owner: "forged", workerId: "forged" },
          body: payload,
        });
        assert.deepEqual(
          new Uint8Array(await new Response(call.output).arrayBuffer()),
          payload,
        );
        const metadata = await call.metadata;
        await call.completed;
        return bytes(String(metadata.owner));
      },
    );
    try {
      assert.equal(await invoke(f.h, { owner: "A" }), "A");
      assert.equal(await invoke(f.h, { owner: "B" }), "B");
    } finally {
      await f.close();
    }
  });

  test(`${kind}: reverse capability is optional and parentless routes deny by default`, {
    timeout: 10_000,
  }, async () => {
    const f = await fixture(
      kind,
      { admit: () => () => bytes("assigned") },
      () => undefined,
    );
    try {
      const denied = await f.worker.callHost({ workload: "receipt" });
      await assert.rejects(
        denied.completed,
        (error) => isHostCallError(error) && error.execution === "not_started",
      );
    } finally {
      await f.close();
    }
    const legacy = await fixture(kind, undefined, async ({ callHost }) => {
      await assert.rejects(
        callHost({ workload: "owner" }),
        (error) => isHostCallError(error) && error.execution === "not_started",
      );
      return bytes("ordinary");
    });
    try {
      assert.equal(await invoke(legacy.h), "ordinary");
    } finally {
      await legacy.close();
    }
    const defaultWorker = await fixture(
      kind,
      { admit: () => () => undefined },
      async ({ callHost }) => {
        await (await callHost({ workload: "owner" })).completed;
        return bytes("automatic-ack");
      },
      false,
    );
    try {
      assert.equal(await invoke(defaultWorker.h), "automatic-ack");
    } finally {
      await defaultWorker.close();
    }
  });

  test(`${kind}: cancelled admission never starts and its global reservation survives replacement`, {
    timeout: 10_000,
  }, async () => {
    const admitted = latch();
    const release = latch();
    let starts = 0;
    const f = await fixture(
      kind,
      {
        maxConcurrent: 1,
        maxPerConnection: 1,
        timeoutMs: 2000,
        admit: () => undefined,
        admitUnassigned: async () => {
          admitted.resolve();
          await release.promise;
          return () => {
            starts++;
          };
        },
      },
      () => undefined,
    );
    try {
      const first = await f.worker.callHost({ workload: "receipt" });
      await admitted.promise;
      await first.cancel();
      await assert.rejects(
        first.completed,
        (error) => isHostCallError(error) && error.execution === "not_started",
      );
      const replacement = await f.connect();
      const blocked = await replacement.callHost({ workload: "receipt" });
      await assert.rejects(
        blocked.completed,
        (error) => isHostCallError(error) && error.execution === "not_started",
      );
      assert.equal(starts, 0);
      release.resolve();
      await sleep(10);
      const next = await replacement.callHost({ workload: "receipt" });
      assert.equal(await text(next), "");
      assert.equal(starts, 1);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  test(`${kind}: lost reply is indeterminate and receipt recovery uses fresh session without replay`, {
    timeout: 10_000,
  }, async () => {
    const committed = latch();
    const finish = latch();
    const receipts = new Map<string, string>();
    let effects = 0;
    const f = await fixture(
      kind,
      {
        admit: () => undefined,
        admitUnassigned: (context) => {
          if (context.workload === "command")
            return async () => {
              effects++;
              receipts.set(context.fence.identity.workerId, "committed-result");
              committed.resolve();
              await finish.promise;
              return bytes("committed-result");
            };
          if (context.workload === "receipt")
            return () =>
              bytes(receipts.get(context.fence.identity.workerId) ?? "missing");
          return undefined;
        },
      },
      () => undefined,
    );
    try {
      const call = await f.worker.callHost({ workload: "command" });
      await committed.promise;
      const replacement = await f.connect();
      await assert.rejects(
        call.completed,
        (error) =>
          isHostCallError(error) && error.execution === "indeterminate",
      );
      assert.equal(
        await text(await replacement.callHost({ workload: "receipt" })),
        "committed-result",
      );
      assert.equal(effects, 1);
    } finally {
      finish.resolve();
      await f.close();
    }
  });

  test(`${kind}: saturated Action dependency refuses boundedly while reverse control progresses`, {
    timeout: 10_000,
  }, async () => {
    let controls = 0;
    const f = await fixture(
      kind,
      {
        admit: (context) =>
          context.workload === "nested"
            ? async () => {
                // The sole execution slot belongs to the caller. Default dispatch must refuse.
                await assert.rejects(
                  h.dispatch({
                    workload: "action",
                    deadlineAtMs: Date.now() + 100,
                  }),
                );
                return bytes("bounded-refusal");
              }
            : undefined,
        admitUnassigned: (context) =>
          context.workload === "receipt"
            ? () => {
                controls++;
                return bytes("control");
              }
            : undefined,
      },
      async ({ callHost }) =>
        bytes(await text(await callHost({ workload: "nested" }))),
    );
    const h = f.h;
    try {
      assert.equal(await invoke(h), "bounded-refusal");
      assert.equal(
        await text(await f.worker.callHost({ workload: "receipt" })),
        "control",
      );
      assert.equal(controls, 1);
    } finally {
      await f.close();
    }
  });

  test(`${kind}: drain permits existing assignment calls and refuses new unassigned calls`, {
    timeout: 10_000,
  }, async () => {
    const running = latch();
    const proceed = latch();
    let saved: import("../work/host-call.ts").HostCaller | undefined;
    const f = await fixture(
      kind,
      { admit: () => () => bytes("during-drain") },
      async ({ callHost }) => {
        saved = callHost;
        running.resolve();
        await proceed.promise;
        return bytes(await text(await callHost({ workload: "owner" })));
      },
    );
    try {
      const result = invoke(f.h);
      await running.promise;
      const draining = f.h.drain("trusted-worker");
      for (let i = 0; i < 100 && f.worker.snapshot().state !== "draining"; i++)
        await sleep(1);
      assert.equal(f.worker.snapshot().state, "draining");
      await assert.rejects(
        f.worker.callHost({ workload: "receipt" }),
        isHostCallError,
      );
      proceed.resolve();
      assert.equal(await result, "during-drain");
      await draining;
      await assert.rejects(
        saved!({ workload: "owner" }),
        (error) => isHostCallError(error) && error.execution === "not_started",
      );
    } finally {
      proceed.resolve();
      await f.close();
    }
  });

  test(`${kind}: request-half cancellation still returns output and post-start cancel stays indeterminate`, {
    timeout: 10_000,
  }, async () => {
    const began = latch();
    const release = latch();
    const f = await fixture(
      kind,
      {
        admit: () => undefined,
        admitUnassigned: (context) =>
          context.workload === "early"
            ? async ({ input }) => {
                await input.cancel();
                return bytes("response");
              }
            : async () => {
                began.resolve();
                await release.promise;
                return bytes("late");
              },
      },
      () => undefined,
    );
    try {
      assert.equal(
        await text(
          await f.worker.callHost({
            workload: "early",
            body: new Uint8Array(1024 * 1024),
          }),
        ),
        "response",
      );
      const call = await f.worker.callHost({ workload: "slow" });
      await began.promise;
      await call.cancel();
      await assert.rejects(
        call.completed,
        (error) =>
          isHostCallError(error) && error.execution === "indeterminate",
      );
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

for (const kind of ["in-process", "websocket"] as const) {
  test(`${kind}: reverse lifetime exhaustion refuses locally and rotates without losing the parent`, {
    timeout: 10_000,
  }, async () => {
    const f = await fixture(
      kind,
      { admit: () => () => bytes("ok") },
      async ({ callHost }) => {
        assert.equal(await text(await callHost({ workload: "owner" })), "ok");
        assert.equal(await text(await callHost({ workload: "owner" })), "ok");
        await assert.rejects(
          callHost({ workload: "owner" }),
          (error: unknown) => {
            assert.ok(isHostCallError(error));
            assert.equal(error.code, "capacity");
            assert.equal(error.execution, "not_started");
            return true;
          },
        );
        return bytes("parent survived");
      },
      true,
      4,
    );
    try {
      const previous = f.h.sessions.get("trusted-worker")!.connectionId;
      assert.equal(await invoke(f.h), "parent survived");
      const deadline = Date.now() + 2000;
      while (
        f.h.sessions.get("trusted-worker")?.connectionId === previous ||
        f.h.sessions.get("trusted-worker")?.phase !== "ready"
      ) {
        assert.ok(Date.now() < deadline, "lifetime rotation reconnects");
        await sleep(5);
      }
      assert.equal(await invoke(f.h), "parent survived");
    } finally {
      await f.close();
    }
  });
}

for (const kind of ["in-process", "websocket"] as const) {
  for (const direction of ["request", "response"] as const) {
    test(`${kind}: aggregate ${direction} limit spans chunks and preserves other calls`, {
      timeout: 10_000,
    }, async () => {
      const chunked = (size: number) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < size; offset += 2)
              controller.enqueue(new Uint8Array(Math.min(2, size - offset)));
            controller.close();
          },
        });
      const f = await fixture(
        kind,
        {
          maxRequestBytes: 4,
          maxResponseBytes: 4,
          admit:
            (context) =>
            async ({ input }) => {
              const body = new Uint8Array(
                await new Response(input).arrayBuffer(),
              );
              return direction === "request"
                ? body
                : chunked(context.metadata.size as number);
            },
        },
        async ({ callHost }) => {
          for (const size of [4, 5, 4]) {
            const call = await callHost({
              workload: "owner",
              metadata: { size },
              body: direction === "request" ? chunked(size) : undefined,
            });
            const output = new Response(call.output).arrayBuffer();
            if (size === 5) {
              const check = (error: unknown) =>
                isHostCallError(error) &&
                error.code === "payload_too_large" &&
                error.execution === "indeterminate";
              await assert.rejects(output, check);
              await assert.rejects(call.completed, check);
            } else {
              assert.equal((await output).byteLength, 4);
              await call.completed;
            }
          }
          return bytes("bounded");
        },
        false,
      );
      try {
        assert.equal(await invoke(f.h), "bounded");
      } finally {
        await f.close();
      }
    });
  }
}

for (const kind of ["in-process", "websocket"] as const) {
  test(`${kind}: queued reverse Opens reserve lifetime before concurrent admission`, {
    timeout: 10_000,
  }, async () => {
    const f = await fixture(
      kind,
      { admit: () => () => bytes("ok") },
      async ({ callHost }) => {
        const calls = await Promise.allSettled(
          Array.from({ length: 3 }, () => callHost({ workload: "owner" })),
        );
        assert.equal(
          calls.filter((call) => call.status === "fulfilled").length,
          2,
        );
        const refused = calls.find((call) => call.status === "rejected");
        assert.ok(
          refused?.status === "rejected" && isHostCallError(refused.reason),
        );
        assert.equal(refused.reason.code, "capacity");
        assert.equal(refused.reason.execution, "not_started");
        for (const call of calls)
          if (call.status === "fulfilled")
            assert.equal(await text(call.value), "ok");
        return bytes("queued safely");
      },
      true,
      4,
    );
    try {
      assert.equal(await invoke(f.h), "queued safely");
    } finally {
      await f.close();
    }
  });

  test(`${kind}: forward lifetime rotation leaves reverse slots for the final parent`, {
    timeout: 10_000,
  }, async () => {
    const f = await fixture(
      kind,
      { admit: () => () => bytes("ok") },
      async ({ callHost }) =>
        bytes(await text(await callHost({ workload: "owner" }))),
      false,
      4,
    );
    try {
      assert.equal(await invoke(f.h), "ok");
      assert.equal(await invoke(f.h), "ok");
    } finally {
      await f.close();
    }
  });
}
