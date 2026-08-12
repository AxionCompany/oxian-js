# Operations

Oxian separates process-local connection ownership from application durability.
The Hypervisor owns live sessions, protocol order, flow control, and exact
assignment. Your application owns attempts, credentials, acceptance records,
results, and cross-replica routing.

## Production composition

```ts
import { createHttpGateway } from "jsr:@oxian/oxian-js@0.21.0-rc.6/http";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.6/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.21.0-rc.6/adapters/deno";

const hypervisor = createHypervisor(
  {
    transports: [{
      type: "websocket",
      config: { path: "/_oxian/workers/connect" },
    }],
    admit: async (context) => {
      return await database.transaction(async (tx) => {
        const attempt = await tx.attempts.assertCurrent(context.identity);
        const exchange = await tx.credentials.exchange({
          identity: context.identity,
          credential: context.credential,
          handshakeId: context.handshakeId,
        });
        return {
          definition: attempt.definition,
          sessionGeneration: exchange.sessionGeneration,
          authenticatedWith: exchange.authenticatedWith,
          resume: exchange.resume,
          bootstrap: await tx.workers.bootstrap(context.identity),
        };
      });
    },
  },
  {
    onReady: (context) => presence.commitReady(context),
    onHeartbeat: (context) => presence.commitHeartbeat(context),
    onWorkAssigned: (context) => assignments.record(context),
    onWorkAccepted: (context) => deliveries.commitAccepted(context),
    onComplete: (context) => deliveries.complete(context),
    onDisconnect: (context) => {
      void presence.enqueueDisconnect(context);
    },
  },
);

const gateway = createHttpGateway({ dispatch: hypervisor.dispatch });
const listener = serve({
  hypervisor,
  hostname: "0.0.0.0",
  port: 8080,
});
```

The runtime adapter owns the listener, never the injected Hypervisor. Shutdown
both explicitly in the layer that created them.

## Durable lifecycle rules

### Activation and registration

`activate` must atomically reuse the current nonterminal attempt or create the
next epoch. `register` issues an identity-bound one-use credential. `admit` must
atomically verify the complete identity, consume/rotate the presented
credential, increment the session generation, and retain bounded exact-handshake
replay for a lost Welcome.

A resume and its handshake ID are one durable unit. Worker `handshake` uses
`replacesHandshakeId` as compare-and-set input so a late completion cannot
overwrite a newer rotation.

### Presence

Hypervisor `onReady` and `onHeartbeat` are fail-closed, connection-ordered
gates. Persist the complete `SessionFence` and a monotonic disconnect tombstone
or generation high-watermark. An aborted callback may still commit, so a late
Ready write must never resurrect a fence already observed as disconnected.

`onDisconnect` is nonblocking. Enqueue its durable work and return; do not let
an external store retain socket resources during cleanup.

### Work assignment and acceptance

`onWorkAssigned` occurs before `work.open`. Its failure proves no offer was
emitted, so Oxian withdraws the reservation.

After the Worker sends `work.accepted`, Hypervisor `onWorkAccepted` is the
durable no-replay gate. Commit by stable operation ID and stage ID. Only a
confirmed callback lets Oxian send `work.start`. If the callback rejects or its
outcome becomes unknowable, classify the work as indeterminate and never blindly
replay it. The callback includes the exact target, deadline, delivery count,
assignment fence and stream, and `acceptedAtMs`, so persistence never has to
infer an acceptance record from mutable routing state.

External side effects should receive the operation/stage idempotency key. A
completed callback may be retried by the surrounding application even when the
protocol terminal is already authoritative.

## Failure classification

| Boundary                            | Safe classification                           | Operator action                             |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------- |
| Before `work.open`                  | Definitely unoffered                          | Retry normally                              |
| After Open, before `work.accepted`  | Reschedulable                                 | Retry on a ready Worker                     |
| Worker rejected before Start        | Reschedulable or failed by explicit reason    | Apply policy                                |
| Acceptance callback outcome unknown | Indeterminate                                 | Reconcile durable record; never auto-replay |
| After `work.start`                  | At-most-once/indeterminate on connection loss | Reconcile workload side effects             |
| Terminal frame received             | Terminal result authoritative                 | Persist/ack completion idempotently         |

Cancellation cannot erase the no-replay boundary. Once acceptance may have
committed, capacity remains reserved until peer terminal acknowledgement or
connection loss settles the stream.

## Routing and replicas

A Hypervisor knows only Workers attached to its process. `assign` receives the
current ready/capable `SessionFence` values for that process and must return one
of them. Built-in assignment respects exact target, workload declaration,
capacity, and least-load balancing.

For multiple Hypervisor replicas, keep a durable logical operation owner and a
separate live socket-owner directory. Forward work to the owning replica or use
an application queue. Do not serialize closures or physical socket identities as
durable Worker definitions.

## Transport operations

### In process

Use globally unique topics within a module realm. A topic collision fails during
Hypervisor construction. Shutdown unregisters the topic and closes its addressed
connections. Queue overflow is a transport failure, not permission to bypass
credit flow control.

### WebSocket

Use WSS across process/trust boundaries. Preserve the exact `oxian.worker.v1`
subprotocol. Bound unauthenticated connections, authenticated connections,
frame/message bytes, pending sends, native buffered amount, lifetime streams,
capacity, acceptance commits, and connection age.

Automatic connection-age rotation applies only to WebSocket connections.
In-process event-fabric connections have no intermediary lifetime and remain
available for durable application streams until explicitly drained or stopped.

## Drain and shutdown

- `hypervisor.drain(workerId)` stops new assignment, waits for active streams,
  sends Drain, and permits reconnect/rotation.
- `shutdownWorker(workerId)` performs terminal Worker shutdown.
- `shutdownSession(fence)` affects only that exact generation, so stale cleanup
  cannot stop a replacement.
- `hypervisor.shutdown()` stops new connections, closes transport bindings,
  drains active sessions, and releases process resources.
- `worker.stop()` stops only that Worker capability.

Injected listeners, dispatchers, providers, or Hypervisors remain app-owned. A
component must close only resources it created.

## Observability

Record at least:

- lifecycle `stage`, `stageId`, callback attempt, duration, and outcome;
- complete Worker identity and session fence;
- operation ID, stream ID, workload, target, and delivery count;
- callback failures and indeterminate acceptance;
- reconnects, lease expiry, drain/shutdown reasons, and peer close diagnostics;
- queue depth/bytes, socket buffered amount, credit stalls, and capacity; and
- `HypervisorSnapshot`, `WorkerSnapshot`, and provider resource state.

Do not treat peer-provided close text as trusted lifecycle policy.

## Verification commands

```sh
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.6/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.21.0-rc.6/bin routes --config oxian.config.ts
```

Test crash points before dispatch, after acceptance ACK, during the durable
acceptance callback, after Start, and after idempotent output but before
external settlement. Run the same behavioral suite through in-process and WSS
transports.
