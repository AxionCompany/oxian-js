import { toFileUrl } from "@std/path";
import { serve as serveCurrent } from "../src/adapters/deno/index.ts";
import { createHypervisor as createCurrentHypervisor } from "../src/hypervisor/index.ts";
import { createWorker as createCurrentWorker } from "../src/worker/index.ts";

type WorkBody = Uint8Array | ReadableStream<Uint8Array>;

type BenchHarness = Readonly<{
  dispatch(
    input: Readonly<{
      workload: string;
      body: WorkBody;
    }>,
  ): Promise<
    Readonly<{
      output: ReadableStream<Uint8Array>;
      completed: Promise<Readonly<{ status: string }>>;
    }>
  >;
  close(): Promise<void>;
}>;

type HarnessFactory = () => Promise<BenchHarness>;

type Metric = Readonly<{
  topology: string;
  scenario: "startup" | "small" | "concurrent" | "stream-1mib";
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}>;

const oldRootInput = Deno.args[0];
if (oldRootInput === undefined) {
  throw new TypeError(
    "usage: deno run --allow-all scripts/benchmark_v020_v021.ts <v0.20.0-rc.7-worktree>",
  );
}
const oldRootUrl = toFileUrl(`${await Deno.realPath(oldRootInput)}/`);
const oldModule = (path: string): string => new URL(path, oldRootUrl).href;
const oldAdapter = await import(oldModule("src/adapters/deno/index.ts"));
const oldHypervisorApi = await import(oldModule("src/hypervisor/index.ts"));
const oldSupervisorApi = await import(oldModule("src/supervisor/index.ts"));
const oldWorkerApi = await import(oldModule("src/worker/index.ts"));

const encoder = new TextEncoder();
let harnessSequence = 0;

function nextId(prefix: string): string {
  harnessSequence++;
  return `${prefix}-${harnessSequence}`;
}

function workerUrl(base: URL, path: string): URL {
  const url = new URL(path, base);
  url.protocol = "ws:";
  return url;
}

function streamBody(totalBytes = 1024 * 1024): ReadableStream<Uint8Array> {
  const chunkBytes = 64 * 1024;
  let emitted = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - emitted);
      const chunk = new Uint8Array(size);
      chunk.fill((emitted / chunkBytes) % 251);
      emitted += size;
      controller.enqueue(chunk);
    },
  });
}

async function execute(
  harness: BenchHarness,
  body: WorkBody,
  expectedBytes: number,
): Promise<void> {
  const handle = await harness.dispatch({ workload: "bench.echo", body });
  const output = await new Response(handle.output).arrayBuffer();
  if (output.byteLength !== expectedBytes) {
    throw new Error(
      `benchmark output was ${output.byteLength} bytes; expected ${expectedBytes}`,
    );
  }
  const completion = await handle.completed;
  if (completion.status !== "completed") {
    throw new Error(`benchmark work settled as ${completion.status}`);
  }
}

async function createCurrentLocalHarness(): Promise<BenchHarness> {
  const id = nextId("v021-local");
  const transport = {
    type: "in-process" as const,
    config: { topic: id },
  };
  const hypervisor = createCurrentHypervisor({ transports: [transport] });
  const worker = createCurrentWorker({
    id,
    transport,
    workloads: {
      "bench.echo": ({ input }) => input,
    },
    capacity: 32,
  });
  await worker.ready;
  return Object.freeze({
    dispatch: hypervisor.dispatch,
    async close() {
      await hypervisor.shutdown("benchmark_complete");
      await worker.stop("benchmark_complete");
      await worker.closed;
    },
  });
}

async function createOldLocalHarness(): Promise<BenchHarness> {
  const id = nextId("v020-local");
  const hypervisor = oldHypervisorApi.createHypervisor({
    persistAcceptance: () => Promise.resolve(),
  });
  const worker = oldWorkerApi.createWorker({
    id,
    transport: { type: "in-process", hypervisor },
    workloads: {
      "bench.echo": ({ input }: { input: ReadableStream<Uint8Array> }) => input,
    },
    capacity: 32,
  });
  const running = worker.run();
  await worker.whenReady();
  return Object.freeze({
    dispatch: hypervisor.dispatch,
    async close() {
      await hypervisor.shutdown("benchmark_complete");
      await worker.stop("benchmark_complete");
      await running;
    },
  });
}

async function createOldProvisioning(workerId: string) {
  const repository = oldSupervisorApi.createInMemoryWorkerRepository();
  await repository.define(oldSupervisorApi.createWorkerDefinition({
    workerId,
    providerId: "benchmark",
    workloads: ["bench.echo"],
    capacity: 32,
  }));
  const identity = (await repository.activate(workerId)).attempt.identity;
  const authority = oldSupervisorApi.createInMemoryRegistrationAuthority();
  const registration = await authority.issueRegistration(identity);
  return { repository, identity, authority, registration };
}

async function createCurrentWebSocketHarness(): Promise<BenchHarness> {
  const id = nextId("v021-ws");
  const { repository, identity, authority, registration } =
    await createOldProvisioning(id);
  const path = `/_oxian/bench/${id}`;
  const hypervisor = createCurrentHypervisor({
    transports: [{ type: "websocket", config: { path } }],
    admit: async (context) => {
      await repository.assertCurrent(context.identity);
      const definition = await repository.getDefinition(
        context.identity.workerId,
      );
      if (definition === undefined) throw new Error("definition missing");
      const exchange = await authority.exchange({
        identity: context.identity,
        credential: context.credential,
        handshakeId: context.handshakeId,
      });
      return {
        definition,
        sessionGeneration: exchange.sessionGeneration,
        authenticatedWith: exchange.authenticatedWith,
        resume: {
          credential: exchange.resume.credential,
          expiresAtMs: exchange.resume.expiresAtMs,
        },
      };
    },
  });
  const listener = serveCurrent({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = createCurrentWorker({
    id,
    transport: {
      type: "websocket",
      config: {
        url: workerUrl(listener.url, path),
        allowInsecureLoopback: true,
      },
    },
    activate: () => identity,
    register: () => registration,
    workloads: {
      "bench.echo": ({ input }) => input,
    },
    capacity: 32,
  });
  await worker.ready;
  return Object.freeze({
    dispatch: hypervisor.dispatch,
    async close() {
      await hypervisor.shutdown("benchmark_complete");
      await worker.stop("benchmark_complete");
      await listener.shutdown();
      await worker.closed;
    },
  });
}

async function createOldWebSocketHarness(): Promise<BenchHarness> {
  const id = nextId("v020-ws");
  const { repository, identity, authority, registration } =
    await createOldProvisioning(id);
  const hypervisor = oldHypervisorApi.createHypervisor({
    admission: { type: "registered", authority, repository },
    persistAcceptance: () => Promise.resolve(),
  });
  const listener = oldAdapter.serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = oldWorkerApi.createWorker({
    transport: {
      type: "websocket",
      url: workerUrl(listener.url, hypervisor.config.workerPath),
      allowInsecureLoopback: true,
    },
    identity,
    credential: registration.credential,
    credentialPersistence: "ephemeral",
    workloads: {
      "bench.echo": ({ input }: { input: ReadableStream<Uint8Array> }) => input,
    },
    capacity: 32,
  });
  const running = worker.run();
  await worker.whenReady();
  return Object.freeze({
    dispatch: hypervisor.dispatch,
    async close() {
      await hypervisor.shutdown("benchmark_complete");
      await worker.stop("benchmark_complete");
      await listener.shutdown();
      await running;
    },
  });
}

function metric(
  topology: string,
  scenario: Metric["scenario"],
  samples: readonly number[],
): Metric {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
  const round = (value: number): number => Number(value.toFixed(3));
  return Object.freeze({
    topology,
    scenario,
    samples: samples.length,
    meanMs: round(
      samples.reduce((sum, value) => sum + value, 0) / samples.length,
    ),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
  });
}

async function benchmark(
  topology: string,
  factory: HarnessFactory,
): Promise<readonly Metric[]> {
  const startup: number[] = [];
  for (let index = 0; index < 10; index++) {
    const started = performance.now();
    const harness = await factory();
    startup.push(performance.now() - started);
    await harness.close();
  }

  const harness = await factory();
  const smallBody = encoder.encode("oxian");
  try {
    for (let index = 0; index < 10; index++) {
      await execute(harness, smallBody, smallBody.byteLength);
    }
    const small: number[] = [];
    for (let index = 0; index < 100; index++) {
      const started = performance.now();
      await execute(harness, smallBody, smallBody.byteLength);
      small.push(performance.now() - started);
    }

    const concurrent: number[] = [];
    for (let batch = 0; batch < 20; batch++) {
      const started = performance.now();
      await Promise.all(Array.from(
        { length: 16 },
        () => execute(harness, smallBody, smallBody.byteLength),
      ));
      concurrent.push((performance.now() - started) / 16);
    }

    const streamed: number[] = [];
    for (let index = 0; index < 10; index++) {
      const started = performance.now();
      await execute(harness, streamBody(), 1024 * 1024);
      streamed.push(performance.now() - started);
    }
    return Object.freeze([
      metric(topology, "startup", startup),
      metric(topology, "small", small),
      metric(topology, "concurrent", concurrent),
      metric(topology, "stream-1mib", streamed),
    ]);
  } finally {
    await harness.close();
  }
}

const metrics = (
  await Promise.all([
    benchmark("v0.20 direct local", createOldLocalHarness),
    benchmark("v0.21 event-fabric local", createCurrentLocalHarness),
    benchmark("v0.20 loopback WebSocket", createOldWebSocketHarness),
    benchmark("v0.21 loopback WebSocket", createCurrentWebSocketHarness),
  ])
).flat();

console.table(metrics);
console.log(JSON.stringify({ measuredAt: new Date().toISOString(), metrics }));
