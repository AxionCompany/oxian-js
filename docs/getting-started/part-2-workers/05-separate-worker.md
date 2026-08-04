# Chapter 5: Separate the worker

Logwash currently looks like one server. The `dev` and `start` commands compose
an HTTP gateway, a Hypervisor listener, and an in-process HTTP worker host. That
lightweight default keeps the worker contract visible, but it hides the network
boundary we now want to deploy.

## The pain

The gateway and the code that redacts a message now share one process lifetime.
You cannot restart, replace, or move the worker independently, and it is hard to
see which side owns an inbound port.

## The solution

Run the same pieces as two localhost processes:

```text
curl
  |
  v
gateway.ts :8000  <----- outbound ws -----  worker.ts
HTTP gateway + Hypervisor                    Logwash application
```

Only `gateway.ts` listens. The worker opens a WebSocket to the Hypervisor,
becomes ready, sends heartbeats, and receives HTTP work over that connection. It
does not start an HTTP server.

This chapter uses an in-memory authority and an ephemeral resume credential to
keep the first split understandable. Those choices are appropriate only for this
localhost exercise.

## 1. Add the gateway process

Create `gateway.ts` in the Logwash project root:

```ts
import {
  createHttpGateway,
  HTTP_WORKLOAD,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/http";
import { createDenoHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.5/adapters/deno";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/supervisor";

const WORKER_ID = "logwash-http";
const CAPACITY = 2;

const repository = createInMemoryWorkerRepository();
await repository.define(createWorkerDefinition({
  workerId: WORKER_ID,
  providerId: "local-attached",
  workloads: [HTTP_WORKLOAD],
  capacity: CAPACITY,
}));

const identity = (await repository.activate(WORKER_ID)).attempt.identity;
const authority = createInMemoryRegistrationAuthority();
const registration = await authority.issueRegistration(identity);

const hypervisorRef: {
  current?: ReturnType<typeof createDenoHypervisor>;
} = {};
const httpGateway = createHttpGateway({
  dispatch(input) {
    const hypervisor = hypervisorRef.current;
    if (hypervisor === undefined) {
      return Promise.reject(new Error("Hypervisor is not ready"));
    }
    return hypervisor.dispatch(input);
  },
});

const hypervisor = createDenoHypervisor({
  authority,
  repository,
  // This resolves the no-replay gate but is not durable. Chapter 6 replaces
  // it at the application boundary.
  persistAcceptance: async (commit) => {
    console.log(`accepted ${commit.operationId}`);
  },
  fallback: httpGateway,
});
hypervisorRef.current = hypervisor;

const listener = hypervisor.listen({
  hostname: "127.0.0.1",
  port: 8000,
});
const gatewayUrl = new URL(
  hypervisor.config.workerPath,
  listener.url,
);
gatewayUrl.protocol = "ws:";

await Deno.mkdir(".oxian", { recursive: true, mode: 0o700 });
await Deno.writeTextFile(
  ".oxian/logwash-local-worker.json",
  JSON.stringify(
    {
      gatewayUrl: gatewayUrl.href,
      identity,
      credential: registration.credential,
      handshakeId: crypto.randomUUID(),
      capacity: CAPACITY,
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);

console.log(`Logwash gateway: ${listener.url.href}`);
console.log(`Worker socket:    ${gatewayUrl.href}`);
console.log("Waiting for logwash-http...");

const monitor = setInterval(() => {
  const session = hypervisor.sessions.get(WORKER_ID);
  if (session === undefined) {
    console.log("logwash-http: offline");
    return;
  }
  console.log(
    `logwash-http: ${session.phase}; next heartbeat ${session.nextHeartbeatSequence}`,
  );
}, 5_000);

const stop = () => {
  void hypervisor.shutdown("process_signal");
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, stop);
}

try {
  await listener.finished;
} finally {
  clearInterval(monitor);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.removeSignalListener(signal, stop);
  }
  await hypervisor.shutdown("gateway_stopped");
}
```

The small JSON file is a localhost provisioning handoff. It contains a one-time
registration capability, so add `.oxian/` to `.gitignore` and never commit it.
The gateway creates a fresh worker attempt and registration each time it starts.

## 2. Add the worker process

Create `worker.ts` beside it:

```ts
import {
  createConfiguredApplication,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/app";
import { loadConfig } from "jsr:@oxian/oxian-js@0.20.0-rc.5/config";
import {
  createHttpWorkload,
  HTTP_WORKLOAD,
} from "jsr:@oxian/oxian-js@0.20.0-rc.5/http";
import type { WorkerIdentity } from "jsr:@oxian/oxian-js@0.20.0-rc.5/protocol";
import { createWorkerClient } from "jsr:@oxian/oxian-js@0.20.0-rc.5/worker";

type LocalProvisioning = Readonly<{
  gatewayUrl: string;
  identity: WorkerIdentity;
  credential: Readonly<{
    kind: "registration";
    capability: string;
  }>;
  handshakeId: string;
  capacity: number;
}>;

const provisioning = JSON.parse(
  await Deno.readTextFile(".oxian/logwash-local-worker.json"),
) as LocalProvisioning;

const lifecycle = new AbortController();
const stop = () => lifecycle.abort("process_signal");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, stop);
}

const config = await loadConfig("./oxian.config.ts");
const { application } = await createConfiguredApplication({
  config: config.application,
  signal: lifecycle.signal,
});
const httpWorkload = createHttpWorkload({
  fetch: application.fetch,
});

const worker = createWorkerClient({
  url: provisioning.gatewayUrl,
  allowInsecureLoopback: true,
  identity: provisioning.identity,
  credential: provisioning.credential,
  handshakeId: provisioning.handshakeId,
  credentialPersistence: "ephemeral",
  workloads: {
    [HTTP_WORKLOAD]: httpWorkload,
  },
  capacity: provisioning.capacity,
  signal: lifecycle.signal,
});
const running = worker.run();

try {
  const ready = await worker.whenReady();
  console.log(
    `Logwash worker ready as ${provisioning.identity.workerId} ` +
      `on ${ready.connectionId}`,
  );
  const result = await running;
  console.log(`Logwash worker stopped: ${result.reason}`);
} finally {
  await worker.stop("worker_process_stopped");
  await running.catch(() => undefined);
  await application.dispose("worker_process_stopped");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    Deno.removeSignalListener(signal, stop);
  }
}
```

The worker still loads `oxian.config.ts`, `application.ts`, `logwash.ts`, and
the existing `routes/` tree. We changed the process topology, not the
application.

## 3. Run both sides

Start the gateway first so it can write the local provisioning handoff:

```bash
deno run -A gateway.ts
```

In a second terminal, start the worker:

```bash
deno run -A worker.ts
```

Wait until the worker prints `Logwash worker ready`. `whenReady()` resolves only
after the Hypervisor has authenticated the worker, delivered `welcome`, accepted
`ready`, published the session, and returned `ready_ack`.

## Verify it

From a third terminal, send the same request used in Chapter 2:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"message":"token=sk-demo"}' \
  http://127.0.0.1:8000/redactions/strict
```

The response schema and redacted output are unchanged from Chapter 2. In the
gateway terminal, the session changes to `ready` and `nextHeartbeatSequence`
continues to increase even when no requests arrive.

Stop only `worker.ts` and repeat the request. The gateway remains online, but it
has no ready worker to execute the HTTP workload. Start both processes again to
restore this deliberately ephemeral exercise.

## What happened

The first connection used a one-time registration capability. The Hypervisor
exchanged it for a resume capability and sent that capability in `welcome`. The
worker adopted it in memory, sent `ready`, waited for `ready_ack`, and then
started heartbeats.

While this worker process remains alive, a dropped socket reconnects with the
in-memory resume capability. A process restart loses it. Replaying the consumed
registration after a session was already published is not a valid restart
strategy, which is why this chapter restarts the gateway and worker together.

For each HTTP request, `createHttpGateway` dispatches `oxian.http.v1` work. The
worker rebuilds a native `Request`, calls the same Logwash application, and
streams its native `Response` back over the outbound WebSocket.

## What this unlocks

Gateway and application execution now have independent processes and lifecycles.
The worker could be replaced by another implementation of the same workload
without changing HTTP ingress, and it still needs no inbound port.

## What's next

In [Chapter 6: Run it on another machine](06-another-machine.md), we will move
this exact worker boundary off localhost. That requires WSS, durable identity
and resume state, and an application-owned enrollment boundary instead of the
local provisioning file.
