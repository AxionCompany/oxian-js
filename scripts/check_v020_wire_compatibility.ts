import { toFileUrl } from "@std/path";
import { serve as serveCurrent } from "../src/adapters/deno/index.ts";
import { createHypervisor as createCurrentHypervisor } from "../src/hypervisor/index.ts";
import { createWorker as createCurrentWorker } from "../src/worker/index.ts";

const oldRootInput = Deno.args[0];
if (oldRootInput === undefined) {
  throw new TypeError(
    "usage: deno run --allow-all scripts/check_v020_wire_compatibility.ts <v0.20.0-rc.7-worktree>",
  );
}
const oldRoot = `${await Deno.realPath(oldRootInput)}/`;
const oldRootUrl = toFileUrl(oldRoot);
const oldModule = (path: string): string => new URL(path, oldRootUrl).href;

const oldAdapter = await import(oldModule("src/adapters/deno/index.ts"));
const oldHypervisorApi = await import(oldModule("src/hypervisor/index.ts"));
const oldSupervisorApi = await import(oldModule("src/supervisor/index.ts"));
const oldWorkerApi = await import(oldModule("src/worker/index.ts"));

const encoder = new TextEncoder();

function workerUrl(base: URL, path: string): URL {
  const url = new URL(path, base);
  url.protocol = "ws:";
  return url;
}

async function roundTrip(
  hypervisor: Readonly<{
    dispatch(
      input: Readonly<{
        workload: string;
        body: Uint8Array;
      }>,
    ): Promise<
      Readonly<{
        output: ReadableStream<Uint8Array>;
        completed: Promise<Readonly<{ status: string }>>;
      }>
    >;
  }>,
  expected: string,
): Promise<void> {
  const handle = await hypervisor.dispatch({
    workload: "compat.echo",
    body: encoder.encode(expected),
  });
  const output = await new Response(handle.output).text();
  if (output !== expected) {
    throw new Error(`wire compatibility output mismatch: ${output}`);
  }
  const completed = await handle.completed;
  if (completed.status !== "completed") {
    throw new Error(
      `wire compatibility work settled as ${completed.status}`,
    );
  }
}

async function currentWorkerToOldHypervisor(): Promise<void> {
  const repository = oldSupervisorApi.createInMemoryWorkerRepository();
  await repository.define(oldSupervisorApi.createWorkerDefinition({
    workerId: "compat-current-worker",
    providerId: "compat",
    workloads: ["compat.echo"],
    capacity: 1,
  }));
  const identity = (await repository.activate("compat-current-worker")).attempt
    .identity;
  const authority = oldSupervisorApi.createInMemoryRegistrationAuthority();
  const registration = await authority.issueRegistration(identity);
  const hypervisor = oldHypervisorApi.createHypervisor({
    admission: { type: "registered", authority, repository },
    persistAcceptance: () => Promise.resolve(),
  });
  const listener = oldAdapter.serve({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = createCurrentWorker({
    id: identity.workerId,
    transport: {
      type: "websocket",
      config: {
        url: workerUrl(listener.url, hypervisor.config.workerPath),
        allowInsecureLoopback: true,
      },
    },
    activate: () => identity,
    register: () => registration,
    workloads: {
      "compat.echo": ({ input }) => input,
    },
  });

  try {
    await worker.ready;
    await roundTrip(hypervisor, "current-worker-to-v020-hypervisor");
  } finally {
    await hypervisor.shutdown("compat_complete").catch(() => undefined);
    await worker.stop("compat_complete").catch(() => undefined);
    await listener.shutdown().catch(() => undefined);
    await worker.closed.catch(() => undefined);
  }
}

async function oldWorkerToCurrentHypervisor(): Promise<void> {
  const repository = oldSupervisorApi.createInMemoryWorkerRepository();
  await repository.define(oldSupervisorApi.createWorkerDefinition({
    workerId: "compat-v020-worker",
    providerId: "compat",
    workloads: ["compat.echo"],
    capacity: 1,
  }));
  const identity = (await repository.activate("compat-v020-worker")).attempt
    .identity;
  const authority = oldSupervisorApi.createInMemoryRegistrationAuthority();
  const registration = await authority.issueRegistration(identity);
  const path = "/_oxian/compat/v020";
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
        bootstrap: {},
      };
    },
  }, {
    onWorkAccepted: () => Promise.resolve(),
  });
  const listener = serveCurrent({
    hypervisor,
    hostname: "127.0.0.1",
    port: 0,
  });
  const worker = oldWorkerApi.createWorker({
    transport: {
      type: "websocket",
      url: workerUrl(listener.url, path),
      allowInsecureLoopback: true,
    },
    identity,
    credential: registration.credential,
    credentialPersistence: "ephemeral",
    workloads: {
      "compat.echo": ({ input }: { input: ReadableStream<Uint8Array> }) =>
        input,
    },
  });
  const workerRun = worker.run();

  try {
    await worker.whenReady();
    await roundTrip(hypervisor, "v020-worker-to-current-hypervisor");
  } finally {
    await hypervisor.shutdown("compat_complete").catch(() => undefined);
    await worker.stop("compat_complete").catch(() => undefined);
    await listener.shutdown().catch(() => undefined);
    await workerRun.catch(() => undefined);
  }
}

await currentWorkerToOldHypervisor();
await oldWorkerToCurrentHypervisor();
console.log(
  "Rolling compatibility passed in both directions against v0.20.0-rc.7.",
);
