# Chapter 7: Workers and providers

Logwash now has a real application boundary: configuration at the root,
redaction logic in `logwash.ts`, startup state in `application.ts`, shared
policy in `routes/_middleware.ts`, ordinary redaction requests in
`routes/redactions/[profile].ts`, and streaming redaction in
`routes/redactions/stream.ts`.

None of those files needs to know where a worker runs.

## The pain

One worker is enough to prove the application, but it is not a platform:

- one connection has one finite capacity;
- a local process is convenient for development but not every deployment;
- a user's computer is already running and must not be "created" by Oxian;
- Cloud Run Jobs can create compute, but a Cloud Run execution is not a routable
  worker until it connects and becomes ready;
- process existence, authenticated presence, readiness, and free capacity are
  different facts.

Putting all of those concerns into a worker runner would couple Logwash to every
compute platform. Putting them into the Hypervisor would make the data plane
responsible for cloud APIs and user-device lifecycle.

## The solution

Use two deliberately separate abstractions:

1. A **worker definition** says which workloads a logical worker may serve and
   the most capacity it may advertise.
2. A **provider** owns only the compute resource for one fenced worker attempt:
   provision it, inspect it, or terminate it.

All workers still attach outbound to the same Hypervisor over WebSocket. The
provider never carries an HTTP request, a Logwash stream, a heartbeat, or a work
result.

```text
local process ───────────┐
user-managed computer ───┼── outbound WSS / oxian.worker.v1 ── Hypervisor
Cloud Run Job task ──────┘

provider API: provision / inspect / terminate
worker WSS:   authenticate / ready / heartbeat / work / result
```

### Define the worker pool

Oxian ships in-memory supervisor components for local use and semantic
reference. They are useful while assembling this example, but they are not a
distributed production control plane.

```ts
// platform/workers.ts
import { HTTP_WORKLOAD } from "jsr:@oxian/oxian-js@0.20.0-rc.3/http";
import {
  createCloudRunJobsProvider,
  createExternallyAttachedProvider,
  createLocalProcessProvider,
} from "jsr:@oxian/oxian-js@0.20.0-rc.3/providers";
import {
  createInMemoryRegistrationAuthority,
  createInMemoryWorkerRepository,
  createWorkerDefinition,
} from "jsr:@oxian/oxian-js@0.20.0-rc.3/supervisor";

export const repository = createInMemoryWorkerRepository();
export const authority = createInMemoryRegistrationAuthority();

export const localProcesses = createLocalProcessProvider();
export const attachedComputers = createExternallyAttachedProvider();
export const cloudRunJobs = createCloudRunJobsProvider({
  project: "logwash-production",
  location: "us-central1",
  // `platformGoogleAuth` is application-owned. Return a bearer token with
  // permission to run, inspect, and cancel the configured Cloud Run Job.
  getAccessToken: ({ signal } = {}) =>
    platformGoogleAuth.getAccessToken({ signal }),
});

const definitions = [
  createWorkerDefinition({
    workerId: "logwash-local-a",
    providerId: localProcesses.providerId,
    workloads: [HTTP_WORKLOAD],
    capacity: 4,
    labels: { pool: "local" },
  }),
  createWorkerDefinition({
    workerId: "logwash-local-b",
    providerId: localProcesses.providerId,
    workloads: [HTTP_WORKLOAD],
    capacity: 4,
    labels: { pool: "local" },
  }),
  createWorkerDefinition({
    workerId: "logwash-attached-alice",
    providerId: attachedComputers.providerId,
    workloads: [HTTP_WORKLOAD],
    capacity: 2,
    labels: { pool: "attached" },
  }),
  createWorkerDefinition({
    workerId: "logwash-cloud-a",
    providerId: cloudRunJobs.providerId,
    workloads: [HTTP_WORKLOAD],
    capacity: 16,
    labels: { pool: "cloud-run" },
  }),
];

for (const definition of definitions) {
  await repository.define(definition);
}
```

A definition's `capacity` is an authorization ceiling. The worker advertises its
current configured capacity in `hello`; the Hypervisor rejects a worker that
advertises more capacity or extra workloads. A worker may advertise less.

For untargeted work, ready sessions with matching workloads and free capacity
are eligible. The process-local session registry chooses the lowest reserved
capacity ratio, with worker ID as a stable tie-breaker. Capacity is reserved per
stream, not per socket message.

### Prepare a fenced attempt

Provisioning is attempt-scoped. The complete identity
`(workerId, attemptId, epoch)` must follow the resource, registration grant, and
eventual WSS session.

```ts
// platform/attempts.ts
import type { WorkerIdentity } from "jsr:@oxian/oxian-js@0.20.0-rc.3/protocol";
import { authority, repository } from "./workers.ts";

export async function beginAttempt(workerId: string): Promise<WorkerIdentity> {
  const activation = await repository.activate(workerId);
  const identity = activation.attempt.identity;
  await repository.transition(identity, { type: "launching" });
  return identity;
}

export async function markResourcePresent(
  identity: WorkerIdentity,
  resourceId: string,
): Promise<void> {
  await repository.transition(identity, {
    type: "running",
    providerInstanceId: resourceId,
  });
}

export async function issueWorkerBootstrap(
  identity: WorkerIdentity,
  capacity: number,
) {
  const registration = await authority.issueRegistration(identity);
  const handshakeId = crypto.randomUUID();

  return {
    handshakeId,
    env: {
      OXIAN_GATEWAY_URL: "wss://control.logwash.example/_oxian/workers/connect",
      OXIAN_WORKER_ID: identity.workerId,
      OXIAN_ATTEMPT_ID: identity.attemptId,
      OXIAN_EPOCH: String(identity.epoch),
      OXIAN_CAPACITY: String(capacity),
      OXIAN_INITIAL_HANDSHAKE_ID: handshakeId,
      OXIAN_REGISTRATION_CAPABILITY: registration.credential.capability,
    },
  } as const;
}
```

The environment names above are an application convention: the reusable
`oxian.worker.ts` manifest must read and validate them. Oxian treats the
capability as opaque. Do not log it, put it in a URL, or copy it into a durable
provider resource.

The in-memory repository and authority make this snippet one-process only. A
production implementation persists attempt fencing, credential consumption,
rotation, and replay protection transactionally.

### Connector 1: local process

The local-process provider launches a direct child process without a shell. Its
default `clearEnv: true` prevents unrelated parent credentials from leaking into
the worker.

```ts
import {
  beginAttempt,
  issueWorkerBootstrap,
  markResourcePresent,
} from "./attempts.ts";
import { localProcesses } from "./workers.ts";

const identity = await beginAttempt("logwash-local-a");
const bootstrap = await issueWorkerBootstrap(identity, 4);
const providerInstanceId = `local:${crypto.randomUUID()}`;

const resource = await localProcesses.provision({
  identity,
  launch: {
    command: Deno.execPath(),
    args: [
      "run",
      "-A",
      "jsr:@oxian/oxian-js@0.20.0-rc.3/bin",
      "worker",
      "--manifest",
      "oxian.worker.ts",
    ],
    cwd: Deno.cwd(),
    clearEnv: true,
    env: bootstrap.env,
    stdout: "inherit",
    stderr: "inherit",
    attributes: { providerInstanceId, pool: "local" },
  },
});

await providerResourceStore.put(providerInstanceId, resource);
await markResourcePresent(identity, providerInstanceId);
```

`provision()` returning means that a child was created. It does not mean that
the child authenticated, completed `ready`, or can receive a redaction.
`providerResourceStore` is an application-owned durable mapping. Its short,
supervisor-safe ID points to the complete provider resource; do not assume every
provider's native resource ID is a supervisor identifier.

Repeat the same flow for `logwash-local-b` to add another independent session.
No route or Logwash function changes.

### Connector 2: externally attached computer

Oxian cannot and should not create a user's laptop. The externally-attached
provider therefore creates a logical, durable reservation.

```ts
import { beginAttempt, markResourcePresent } from "./attempts.ts";
import { attachedComputers } from "./workers.ts";

const identity = await beginAttempt("logwash-attached-alice");
const providerInstanceId = `attached:${crypto.randomUUID()}`;

const resource = await attachedComputers.provision({
  identity,
  launch: {
    attachmentId: "alice-macbook",
    attributes: {
      providerInstanceId,
      owner: "alice",
      pool: "attached",
    },
  },
});

await providerResourceStore.put(providerInstanceId, resource);
await markResourcePresent(identity, providerInstanceId);
```

The reservation is now `present`, even if Alice's computer is asleep. When Alice
signs in through the platform's enrollment flow, that application-owned flow
issues the registration grant and gives the local worker its exact identity,
initial handshake ID, WSS URL, and capability. The worker can then start with
the same CLI used by any other provider:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.3/bin worker --manifest oxian.worker.ts
```

Google sign-in, device approval, secure credential storage, and distribution of
the local executable belong to the product around Oxian. Once enrolled, the
computer is just another `oxian.worker.v1` peer: it reconnects, rotates resume
credentials, sends heartbeats, receives work, and streams results over WSS.

Persist the returned external resource reference. After an orchestrator restart,
`attachedComputers.rehydrateResource(...)` can restore the reservation.
Rehydration restores provider identity only, never socket or readiness state.

### Connector 3: Cloud Run Jobs

Configure a Cloud Run Job whose container starts the same Oxian worker and
manifest. The provider invokes the Cloud Run v2 Jobs API for exactly one task.

```ts
import {
  beginAttempt,
  issueWorkerBootstrap,
  markResourcePresent,
} from "./attempts.ts";
import { cloudRunJobs } from "./workers.ts";

const identity = await beginAttempt("logwash-cloud-a");
const bootstrap = await issueWorkerBootstrap(identity, 16);
const providerInstanceId = `cloud-run:${crypto.randomUUID()}`;

const resource = await cloudRunJobs.provision({
  identity,
  launch: {
    job: "logwash-worker",
    containerOverride: {
      env: bootstrap.env,
    },
    timeoutSeconds: 3_600,
    attributes: { providerInstanceId, pool: "cloud-run" },
  },
});

await providerResourceStore.put(providerInstanceId, resource);
await markResourcePresent(identity, providerInstanceId);
```

Access tokens, launch environment, and registration capabilities are not copied
into the returned durable provider resource. Persist the resource itself so the
orchestrator can inspect, rehydrate, or terminate that exact Cloud Run
execution.

The Cloud Run API reporting an execution as present still does not establish
worker readiness. The only routable truth is the authenticated, fenced session
that completed `ready`.

### Keep the boundary narrow

Every provider has exactly the same lifecycle:

```ts
const inspection = await provider.inspect(resource);
const termination = await provider.terminate(resource, {
  gracePeriodMs: 10_000,
});
```

Interpret those results narrowly:

| Signal                                           | What it proves                                       | What it does not prove                         |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------- |
| `provider.inspect(resource).state === "present"` | The provider still observes compute or a reservation | A WSS connection exists                        |
| Authenticated session                            | A current fenced worker connected                    | The worker finished startup                    |
| Ready session                                    | The worker may receive declared workloads            | Capacity is currently free                     |
| `capacity - reserved > 0`                        | This process may reserve another stream              | Another Hypervisor replica sees the same state |

Custom providers should implement the public `WorkerProvider<TLaunchSpec>`
contract and run `runProviderConformance()` in their own test suite. A custom
provider still must not add sockets, target URLs, readiness, or workload
delivery to `ProviderResource`.

## Verify it

First, verify the application and manifest:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.3/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.3/bin routes --config oxian.config.ts
```

After starting the Hypervisor and the desired workers, compare provider presence
with session readiness:

```ts
console.log((await localProcesses.inspect(localResource)).state);
console.log((await attachedComputers.inspect(attachedResource)).state);

console.table(
  hypervisor.sessions.list().map((session) => ({
    worker: session.identity.workerId,
    phase: session.phase,
    capacity: session.capacity,
    reserved: session.reserved,
    available: session.capacity - session.reserved,
  })),
);
```

Before Alice starts her client, the attached reservation can be `present`
without a corresponding ready session. After the client connects, the same table
should show `logwash-attached-alice` as `ready`.

Send a concurrent wave through the unchanged `routes/redactions/[profile].ts`
endpoint:

```bash
seq 1 24 | xargs -P 12 -I '{}' \
  curl -sS -X POST \
  https://control.logwash.example/redactions/strict \
  -H 'content-type: application/json' \
  --data '{"message":"email=alice@example.com token=sk-secret"}'
```

Use `routes/redactions/stream.ts` for a longer-lived response while observing
reservations. `hypervisor.snapshot()` exposes process-local connection,
acceptance, session, and work-status counters:

```ts
const snapshot = hypervisor.snapshot();
console.log({
  connections: snapshot.connections,
  sessions: snapshot.sessions,
  work: snapshot.work,
  pendingAcceptanceCommits: snapshot.pendingAcceptanceCommits,
});
```

Expected results:

- every response still follows the Logwash route contract;
- more than one ready worker can reserve work concurrently;
- no session exceeds its advertised capacity;
- a provider resource may be present while no session is ready;
- stopping a worker removes its routable session even when the provider has not
  yet observed the resource as absent.

## What happened

We scaled Logwash without adding a cloud branch, laptop branch, or local branch
to the application.

Worker definitions constrained what each logical worker could advertise.
Providers managed fenced compute resources. The supervisor and Hypervisor
authenticated sessions and routed only to ready workers with free capacity.
Every request and response still traveled over the same WSS protocol.

That separation is the useful abstraction: providers answer **where compute
comes from**; worker sessions answer **whether work can move right now**.

## What this unlocks

- Mix cheap local capacity, user-owned computers, and managed cloud tasks in one
  pool.
- Add a provider without changing the worker protocol or Logwash routes.
- Enroll a local computer without exposing an inbound HTTP server on it.
- Scale by adding logical workers or raising their authorized capacity.
- Reconcile compute presence independently from authenticated session health.
- Target a logical worker when affinity is required while retaining attempt and
  session fencing.

It does not create a distributed scheduler. A Hypervisor's sessions and snapshot
are process-local; durable ownership and cross-replica routing remain
application infrastructure.

## What's next

More capacity also creates more failure boundaries. A socket can disappear
before work starts, after acceptance is committed, or while a result is
streaming. A process can be present but unreachable. A graceful deployment must
stop new reservations without abandoning active work.

[Chapter 8: Failures and production](08-failures-and-production.md) defines the
no-replay boundary, application-owned idempotency, graceful lifecycle, secure
transport, and a concrete production release checklist.
