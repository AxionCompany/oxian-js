# Operations

Oxian separates process-local connection ownership from application durability.
The Hypervisor owns live sessions, protocol order, flow control, and exact
assignment. Your application owns attempts, credentials, acceptance records,
results, and cross-replica routing.

## Production composition

```ts
import { createHttpGateway } from "jsr:@oxian/oxian-js@0.22.0/http";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.22.0/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.22.0/adapters/deno";

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

## Bounded dispatch waiting

Capacity rejection remains the 0.21 default. Enable the process-local queue on
shards that should absorb bursts or brief Worker reconnects:

```ts
const hypervisor = createHypervisor({
  transports,
  admit,
  config: {
    maxQueuedDispatches: 1_024,
    dispatchQueueTimeoutMs: 30_000,
  },
});

const work = await hypervisor.dispatch({
  workload,
  target: { workerId },
  body,
  deadlineAtMs: Date.now() + 10_000,
  signal,
});
```

With a positive `maxQueuedDispatches`, both targeted and untargeted dispatch
wait for ready capacity. A missing target may reconnect within the wait bound;
Oxian never substitutes a different logical Worker for an explicit target.
Waiting ends at the earlier of the supplied deadline and arrival plus
`dispatchQueueTimeoutMs` (default 30 seconds). The configured timeout applies
through Open, including `assign` and `onWorkAssigned`, with one shared deadline
in both modes. An explicit deadline also bounds subsequent work. Setting
`maxQueuedDispatches: 0` restores immediate `worker_unavailable` for absent
capacity; it does not remove the timeout on asynchronous dispatch policy.

Explicitly targeted requests are FIFO per target; untargeted requests are FIFO
per workload in separate lanes. A busy or absent computer cannot block work for
other computers exposing the same workload, or untargeted work that can use
another Worker. The scheduler scans arrival order among runnable lane heads.
Targeted and untargeted heads compete for actual reservations; an asynchronous
assignment holds no slot and can lose a race to another lane. There is no FIFO
guarantee between these two classes. Async `assign` calls count against the
queue limit and may be repeated after a capacity/fence race, with stable
operation/stage IDs and increasing `callbackAttempt`. In queue mode they run
only when candidates exist. Honor the callback signal and keep assignment policy
idempotent.

| Pre-Open error code  | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `dispatch_queue_full` | Global queued request-count limit reached; apply upstream backpressure. |
| `dispatch_hook_capacity` | Unsettled dispatch hook limit reached. |
| `deadline_exceeded`   | Explicit deadline or configured entry-to-Open timeout elapsed.    |
| `dispatch_aborted`    | Caller cancelled; `cause` retains the signal reason.             |
| `shutting_down`       | Hypervisor shutdown rejected queued or new dispatch.             |
| `worker_draining`     | An explicit target was drained or shut down.                     |

Drain rejects currently queued requests naming that Worker, even if it is
absent. Requests targeting an attached draining session also reject. Once it is
detached, new requests can wait for its replacement. Untargeted requests remain
eligible for other Workers. Stale `shutdownSession` calls remain no-ops.

`maxPendingDispatchHooks` (default 1,024) separately caps unsettled `assign` and
`onWorkAssigned` callbacks. Monitor `snapshot().pendingDispatchHooks`. Timeout,
cancellation, drain or replacement promptly refuses a pre-Open caller, but does
not reclaim a hook's capacity until its promise settles. `onWorkAssigned` keeps
its offered worker slot while unsettled, unless that session is lost. The host
never opens a late assignment. Honour cancellation in callbacks; timeouts cannot
stop arbitrary application JavaScript. A full hook budget refuses rather than
adding another hidden queue. This budget is independent of reverse-call and
execution capacity, and remains charged across reconnects.

The queue owns no reservation, dispatcher record, or wire stream. Rejection
before offering is safe to retry under application policy. Once offered, the
existing protocol lifecycle applies; the queue does not retry Open failures or
reschedulable/accepted work. Acceptance and no-replay rules are unchanged.

The queue retains body references without reading, locking, or cancelling them.
Callers own body cleanup when dispatch rejects. The bound counts requests, not
bytes, and is global even for independent lanes; size it alongside upstream body
limits. Nothing in the queue survives a Hypervisor process restart.

`snapshot().queuedDispatches` reports the total; `queuedDispatchesByLane`
contains `{ workload, workerId?, count }` groups. Queued requests do not appear
in `snapshot().work` until offered. Built-in session changes wake the queue
without polling. Custom injected registries may implement `subscribe`; otherwise
waiting requests use a 25 ms polling fallback.

On an updated Worker, normal End and handler-error terminals are sent only after
output settlement, Worker `onComplete`, and execution-slot release. This keeps
Hypervisor reservation release aligned with actual capacity. Completion hooks
must not await the Hypervisor's completion of the same operation. Deploy the
Worker update too: unmodified 0.21.2 Workers can report End while still holding
their execution slot, even when queueing is disabled.

Early cancellation acknowledgements and connection loss remain separate from
execution settlement. An uncooperative handler or output source can continue
holding Worker capacity after cancellation or across reconnect, and new Open may
still receive a pre-acceptance `worker_capacity` rejection in that case. The
queue never replays accepted work to hide that condition.

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
Likewise, heartbeat lease expiry applies only to WebSocket sessions. An
in-process Worker shares the Hypervisor's event loop, so an elapsed-time sweep
cannot distinguish a suspended process from a lost local Worker; event-fabric
closure is the liveness signal for that topology.

## Drain and shutdown

- `hypervisor.drain(workerId)` stops new assignment, waits for active streams,
  sends Drain, and permits reconnect/rotation.
- `shutdownWorker(workerId)` performs terminal Worker shutdown.
- `shutdownSession(fence)` affects only that exact generation, so stale cleanup
  cannot stop a replacement.
- `hypervisor.shutdown()` rejects queued/new dispatch, stops new connections,
  closes transport bindings, drains active sessions, and releases process
  resources.
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
deno run -A jsr:@oxian/oxian-js@0.22.0/bin check --config oxian.config.ts
deno run -A jsr:@oxian/oxian-js@0.22.0/bin routes --config oxian.config.ts
```

Test crash points before dispatch, after acceptance ACK, during the durable
acceptance callback, after Start, and after idempotent output but before
external settlement. Run the same behavioral suite through in-process and WSS
transports.
