# Chapter 8: Failures and production

Logwash can now run unchanged on local processes, attached computers, and Cloud
Run Jobs. That makes worker loss normal rather than exceptional.

Production readiness is not the absence of failure. It is knowing which failures
are safe to retry, which outcomes are ambiguous, and which component owns the
durable answer.

## The pain

Consider one request to `routes/redactions/[profile].ts`:

1. The Hypervisor offers it to a worker.
2. The worker reserves capacity.
3. The worker connection disappears.

Did `logwash.ts` execute? May the request be sent to another worker? If Logwash
also writes an audit record or charges usage, can a retry duplicate that side
effect?

A WebSocket reconnect cannot answer those questions. Neither can a provider
inspection, a heartbeat, or a process-local snapshot.

The unsafe shortcut is "retry every disconnected request." The opposite
shortcut—"never retry anything"—turns harmless pre-execution failures into
outages.

## The solution

Oxian makes one boundary explicit and leaves durable business semantics with the
application.

### Understand acceptance and no replay

Work authorization is two-phase:

1. The Hypervisor sends `work.open`.
2. The worker reserves capacity and returns `work.accepted`. It must not invoke
   the handler, consume the request body, or perform side effects yet.
3. The Hypervisor calls the application's `persistAcceptance(commit)`.
4. Only after that promise resolves does the Hypervisor send `work.start`.
5. Only `work.start` authorizes the worker to invoke Logwash.

The successful durable acceptance commit is the **no-replay boundary**.

| Observed outcome                                 | What is known                                        | Retry policy                         |
| ------------------------------------------------ | ---------------------------------------------------- | ------------------------------------ |
| Connection lost before `work.accepted`           | The worker could not have received `work.start`      | A new attempt is safe                |
| Acceptance persistence admission was unavailable | No acceptance commit began                           | A new attempt is safe                |
| `persistAcceptance()` rejected                   | The durable commit outcome may be unknown            | Indeterminate; do not replay blindly |
| Connection lost after acceptance committed       | The worker may or may not have received `work.start` | Indeterminate; never auto-replay     |
| Durable application result exists                | The application knows the outcome                    | Return or reference that result      |

Oxian 0.20 reports a pre-acceptance operation as reschedulable; it does not hide
that decision in an implicit retry loop. The caller or orchestration layer may
issue a new operation. Once acceptance commits, Oxian never resumes or replays
that work after reconnect.

This is intentionally weaker—and more honest—than "exactly once."

### Persist the boundary durably

`persistAcceptance` is required by `createHypervisor`. In production, it must
commit to an application-owned durable store before resolving.

```ts
// platform/hypervisor.ts
import { createHttpGateway } from "jsr:@oxian/oxian-js@0.20.0-rc.4/http";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.4/hypervisor";
import type { AcceptanceCommit } from "jsr:@oxian/oxian-js@0.20.0-rc.4/supervisor";
import { authority, repository } from "./durable_control.ts";

// This factory belongs to Logwash. It is not an Oxian export.
const operations = createLogwashOperationStore(database);

async function persistAcceptance(
  commit: AcceptanceCommit,
): Promise<void> {
  // `commitAccepted` must be transactional and idempotent by operationId.
  // Resolve only after the transaction is durably committed.
  await operations.commitAccepted(commit);
}

const hypervisor = createHypervisor({
  authority,
  repository,
  persistAcceptance,
});

const gateway = createHttpGateway({
  dispatch: async (input) => {
    const handle = await hypervisor.dispatch(input);
    // This application-owned observer records the generated operation ID and
    // watches `handle.completed`; it must manage promise rejection internally.
    operations.observeDispatch(input.metadata, handle);
    return handle;
  },
});

export { gateway, hypervisor };
```

Here `authority`, `repository`, the database, and the operation store are the
durable application implementations introduced at the boundary in Chapter 6;
they are not the in-memory tutorial factories from Chapter 7.

The durable record should retain enough data to answer an operation lookup:

- Oxian `operationId`;
- the caller's stable command or idempotency ID;
- workload and deadline;
- complete worker/session assignment fence from the acceptance commit;
- accepted timestamp and delivery count;
- current application outcome: accepted, running, completed, failed, or
  indeterminate;
- a durable result, result reference, or business transaction ID when one
  exists.

The acceptance transaction should use `operationId` as an idempotent key and a
unique caller command ID as a deduplication key. It must not call back into
`dispatch()`, `drain()`, or anything else that needs frames from the same
worker; the connection's ordered frame loop is waiting for this commit.

Observing `handle.completed` can record the terminal transport status. It does
not make a streamed response durable: Logwash or its downstream transaction must
store the result or a result reference when callers need later retrieval.

If the database reports an error, Oxian cannot know whether a remote commit
happened just before the error. It therefore treats rejection conservatively as
indeterminate.

### Give callers a stable operation ID

Oxian creates a unique operation ID for each dispatch. That ID is excellent for
transport correlation, but a client retry does not know it in advance.

For mutation-like work, require an `Idempotency-Key` or create a stable command
ID at the application edge:

```ts
// platform/idempotent_gateway.ts
import type { HttpGateway } from "jsr:@oxian/oxian-js@0.20.0-rc.4/http";

export function createIdempotentGateway(
  gateway: HttpGateway,
  operations: LogwashOperationStore,
): HttpGateway {
  return async (request) => {
    const commandId = request.headers.get("idempotency-key");
    if (!commandId) {
      return Response.json(
        { error: "idempotency-key is required" },
        { status: 400 },
      );
    }

    const reservation = await operations.reserve(commandId);
    if (reservation.kind === "existing") {
      return operations.responseFor(reservation.operation);
    }

    try {
      return await gateway(request);
    } catch (error) {
      await operations.recordDispatchFailure(commandId, error);
      throw error;
    }
  };
}
```

This snippet shows the ownership boundary, not a storage implementation.
`reserve()` must be an atomic insert-or-read. Because HTTP request metadata
preserves repeated headers, `commitAccepted()` can associate the accepted Oxian
operation with the reserved `Idempotency-Key` in the same durable transaction.

Define duplicate behavior explicitly:

- **completed:** return the stored result or a result URL;
- **accepted, running, or indeterminate:** return the same operation status;
- **proved pre-acceptance failure:** allow a new dispatch under the same command
  ID and record its new Oxian operation ID;
- **conflicting payload for one command ID:** reject it.

The HTTP gateway's generated request ID is correlation, not client idempotency.
For streamed output from `routes/redactions/stream.ts`, storing a result
reference or returning an operation-status URL is usually safer than trying to
recreate a partially consumed stream.

Worker authors should also use the command ID or business key in downstream
transactions. The protocol prevents execution before acceptance; only the
application can make its own database writes, audit records, billing events, or
external API calls idempotent.

### Observe without confusing a snapshot for a checkpoint

`hypervisor.snapshot()` is a synchronous, process-local operational view:

```ts
const snapshot = hypervisor.snapshot();

metrics.gauge("oxian_connections", snapshot.connections);
metrics.gauge("oxian_sessions", snapshot.sessions);
metrics.gauge(
  "oxian_acceptance_commits_pending",
  snapshot.pendingAcceptanceCommits,
);

for (const [status, count] of Object.entries(snapshot.work)) {
  metrics.gauge("oxian_work", count, { status, instance: INSTANCE_ID });
}
```

Use it for metrics, readiness diagnostics, and drain observation. Do not persist
it as recovery state:

- it is not a global view across Hypervisor replicas;
- it is not a snapshot of a worker filesystem or process;
- it does not resume accepted work;
- reconnect credentials resume worker identity, not work streams;
- accepted streams are never replayed after reconnect.

Durable checkpoints for a specific workload may be a valuable application
feature, but they are not required for the Logwash MVP and are not part of
Oxian's generic worker lifecycle.

### Drain, shut down, then terminate compute

Use the narrowest lifecycle primitive for the intent.

```ts
// Rotate a healthy connection for maintenance. The WorkerClient reconnects.
await hypervisor.drain("logwash-cloud-a", "deployment");

// Retire the current client for a logical worker. It receives Shutdown and
// settles instead of reconnecting.
await hypervisor.shutdownWorker(
  "logwash-attached-alice",
  "device_retired",
);

// Attempt-scoped cleanup should use the exact current fence. If that session
// was replaced, this is a no-op and cannot stop the replacement.
await hypervisor.shutdownSession(exactFence, "attempt_settled");
```

Both graceful worker operations reject new reservations and wait for active
streams to settle. `drain()` is maintenance: it closes the connection and the
client reconnects with its resume credential. `shutdownWorker()` and
`shutdownSession()` are terminal for the selected client run.

They do **not** revoke durable authority or terminate provider compute. A
retirement orchestrator owns the full sequence:

```ts
await hypervisor.shutdownSession(exactFence, "attempt_retired");
await authority.revoke(identity);
await repository.transition(identity, { type: "terminate" });

const termination = await provider.terminate(resource, {
  gracePeriodMs: 10_000,
});

if (
  termination.outcome === "terminated" ||
  termination.outcome === "already_absent"
) {
  await repository.transition(identity, { type: "terminated" });
}
```

Use the exact session fence for attempt cleanup so a delayed controller cannot
shut down a newer attempt that reused the same logical worker ID. Preserve and
reconcile an `unknown` provider termination outcome instead of declaring the
resource gone.

At service shutdown, stop new external traffic, drain or terminate workers,
close the Hypervisor, and then close its server:

```ts
await hypervisor.shutdown("service_shutdown");
serverAbort.abort("service_shutdown");
await server.finished;
```

If the server was created by `hypervisor.listen()`, Hypervisor shutdown owns
those listeners. If it was composed into an application-owned `Deno.serve()`,
the application owns that server's signal and completion.

### Require WSS and enforce limits

Workers should connect to `wss:` in every deployed environment. TLS may
terminate at a trusted ingress, or Deno can serve the Hypervisor directly:

```ts
const serverAbort = new AbortController();

const server = Deno.serve({
  hostname: "0.0.0.0",
  port: 8443,
  cert: await Deno.readTextFile("./secrets/tls.crt"),
  key: await Deno.readTextFile("./secrets/tls.key"),
  signal: serverAbort.signal,
}, hypervisor.fetch);
```

Workers offer exactly `oxian.worker.v1` as the WebSocket subprotocol. Do not put
registration or resume credentials in the URL. Use a normal certificate trust
chain in production; local private CAs can be supplied to Deno explicitly during
development.

The wire protocol has hard interoperability and safety ceilings:

| Resource                                | Protocol maximum |
| --------------------------------------- | ---------------: |
| Control frame                           |           64 KiB |
| One binary data payload                 |            1 MiB |
| Outstanding credit per stream direction |           16 MiB |
| Lifetime stream IDs per connection      |           65,536 |
| Advertised worker capacity              |            1,024 |

The Hypervisor can set lower limits for capacity, payload, credit, lifetime
streams, connection counts, buffered bytes, inbound queues, and concurrent
acceptance commits:

```ts
const hypervisor = createHypervisor({
  authority,
  repository,
  persistAcceptance,
  config: {
    maxConnections: 2_000,
    maxUnauthenticatedConnections: 64,
    maxAuthenticatedConnections: 2_000,
    maxWorkerCapacity: 64,
    maxDataPayloadBytes: 256 * 1_024,
    maxReceiveCreditBytes: 4 * 1_024 * 1_024,
    maxPendingAcceptanceCommits: 256,
    maxPendingAcceptanceCommitsPerWorker: 16,
  },
});
```

Credit is independent in each stream direction. Native Web Streams stop pulling
when credit is exhausted, so preserve streaming rather than buffering an entire
request or response around Oxian.

## Verify it

Start with static and route checks:

```bash
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.4/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.4/bin routes --config oxian.config.ts
deno check \
  application.ts \
  logwash.ts \
  routes/index.ts \
  routes/_middleware.ts \
  'routes/redactions/[profile].ts' \
  routes/redactions/stream.ts
```

Then run deterministic failure drills in a test environment. Add test-only gates
around worker acceptance, `persistAcceptance`, and the WSS connection; assert
the observable outcome rather than relying on timing.

| Drill                                                            | Expected assertion                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Disconnect before `work.accepted`                                | Handler did not run; operation is safe to submit again                                  |
| Disconnect after `work.accepted` but before acceptance commit    | Handler did not run; retry only after the store proves no commit                        |
| Make `persistAcceptance` reject                                  | Operation reports `indeterminate`; no automatic replay occurs                           |
| Commit acceptance, then drop WSS before `work.start` is observed | Operation reports `indeterminate`; duplicate submission returns the same command status |
| Drop WSS while `logwash.ts` executes                             | Accepted work is not resumed after reconnect                                            |
| Drain during concurrent requests                                 | No new work is reserved on that session; active streams settle before close             |
| Shut down a worker                                               | Client settles with shutdown and does not reconnect                                     |
| Run stale `shutdownSession` after replacement                    | New fenced session remains connected                                                    |
| Keep an attached reservation while its computer sleeps           | Provider remains present; no ready session is advertised                                |

For each drill, inspect three independent records:

1. the durable operation row and idempotency mapping;
2. process-local `hypervisor.snapshot()` and `hypervisor.sessions.list()`;
3. provider `inspect(resource)`.

They should agree where their concerns overlap, but none substitutes for the
others.

### Production and release checklist

Before releasing Logwash on Oxian 0.20, verify every item:

- [ ] **Wire compatibility:** every worker and Hypervisor supports
      `oxian.worker.v1`; mixed package versions are tested against that wire
      version.
- [ ] **Secure transport:** the public worker URL is `wss:`, certificate trust
      and rotation are tested, and credentials never appear in URLs or logs.
- [ ] **Durable authority:** registration exchange atomically consumes and
      rotates capabilities; exact lost-Welcome replay is bounded; revocation and
      per-attempt session-generation high-watermarks survive restarts.
- [ ] **Durable repository:** activation and transitions compare the complete
      `(workerId, attemptId, epoch)` fence and cannot publish stale attempts.
- [ ] **Session lifecycle:** ready and heartbeat persistence use the complete
      session fence; late writes cannot resurrect a disconnected session.
- [ ] **Acceptance store:** `persistAcceptance` is transactional, idempotent by
      Oxian operation ID, deduplicated by client command ID, and resolves only
      after durable commit.
- [ ] **Outcome API:** callers can look up completed, failed, running, and
      indeterminate commands without blindly dispatching again.
- [ ] **Workload idempotency:** Logwash audit, billing, and downstream effects
      use the same stable business key or document why replay is harmless.
- [ ] **Resume storage:** long-lived workers persist rotated resume credential
      and handshake ID together in a protected store; ephemeral credentials are
      an explicit choice only for disposable workers.
- [ ] **Provider recovery:** durable provider resources are retained; externally
      attached and Cloud Run resources are rehydrated and reconciled after
      controller restart.
- [ ] **Provider conformance:** every built-in or custom connector passes
      `runProviderConformance()` with its real launch-spec adapter.
- [ ] **Capacity and limits:** authorized capacity, connection ceilings,
      acceptance concurrency, payload sizes, credit, timeouts, and Cloud Run
      task lifetime are load-tested.
- [ ] **Graceful lifecycle:** deployment, rotation, worker retirement, stale
      cleanup, provider-unknown reconciliation, and whole-service shutdown have
      rehearsed runbooks.
- [ ] **Observability:** metrics distinguish provider presence, authenticated
      connection, ready session, reserved capacity, acceptance backlog, and
      durable operation outcome; per-instance snapshots are never presented as a
      global count.
- [ ] **Failure tests:** pre-acceptance loss, ambiguous acceptance, post-commit
      loss, reconnect, credential rotation, lease expiry, backpressure, and
      drain under load are automated.
- [ ] **Release artifacts:** worker images and local downloads are pinned by
      digest or signed version; configuration and migration changes are reviewed
      with the artifact.
- [ ] **Rollout:** a canary proves WSS connectivity and acceptance persistence
      before capacity is expanded; rollback drains new workers and preserves
      operation records.

## What happened

Oxian gave Logwash a precise execution gate:

```text
work.open → work.accepted → durable acceptance → work.start → handler
                                ↑
                         no-replay boundary
```

Before the boundary, execution was impossible and another submission can be
safe. At or after the boundary, transport loss is ambiguous and Oxian refuses to
guess. The application-owned operation store, idempotency key, and business
transaction provide the durable answer.

Graceful lifecycle follows the same separation. The Hypervisor drains or shuts
down sessions. The authority revokes credentials. The repository fences
attempts. The provider terminates compute.

## What this unlocks

- Safe multi-provider operation without claiming exactly-once execution.
- User-visible operation lookup for ambiguous or long-running work.
- Planned worker rotation without accepting new work during shutdown.
- Attempt-safe cleanup that cannot terminate a replacement session.
- WSS deployments with bounded memory, concurrency, and stream pressure.
- Failure drills and release gates based on explicit ownership.

Most importantly, the design scales responsibility as well as compute. Oxian
owns strict process-local sessions and the no-replay protocol boundary. It does
not own a distributed scheduler, globally durable routing, application
idempotency, result persistence, or workload checkpoints.

## What's next

Logwash is now a platform-shaped application: the same routes and worker runtime
can run through multiple provider connectors, while production durability
remains explicit.

Use the deeper references when replacing the tutorial's in-memory components:

- [Architecture](../../architecture.md)
- [Operations](../../operations.md)
- [Workers](../../workers.md)
- [Worker protocol v1](../../worker-protocol-v1.md)
- [API reference](../../api-reference.md)
