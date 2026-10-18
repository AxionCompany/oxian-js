# Optional worker-to-host calls

Workers can invoke application-defined workloads on the Hypervisor that owns
their current connection. Both in-process and WebSocket transports use the same
negotiated, credited protocol streams. Enable `workerCalls` on the Hypervisor
to supply explicit admission policy; supporting workers acknowledge the offer
automatically. Worker `hostCalls` only configures capacity and timeout. Missing
negotiation disables calls, with no alternative transport or database path.

This is generic transport and admission, not a durable owner implementation.
Database transactions, grants, receipts, owner epochs, routing between hosts,
and recovery remain application responsibilities. It does not establish that the
concrete Copilotz owner runtime or its conformance work is complete.

These examples describe the current 0.22 prerelease source API. Use an exact
published prerelease containing this extension when installing from a registry.

## One assigned call

```ts
import { createHypervisor, createWorker } from "oxianjs";

const transport = {
  type: "in-process",
  config: { topic: "example.host-calls" },
} as const;

const hypervisor = createHypervisor({
  transports: [transport],
  workerCalls: {
    maxConcurrent: 2,
    maxPerConnection: 1,
    admit(context) {
      // Private example policy. Production applications also check their
      // grants, tenant/owner binding, and any forwarded client's authority.
      if (
        context.workload !== "example.uppercase" ||
        context.parent?.workload !== "example.task"
      ) return undefined;

      // Admission returns a handler; it must not perform the call's effects.
      return async ({ input, signal }) => {
        signal.throwIfAborted();
        const value = await new Response(input).text();
        signal.throwIfAborted();
        return new TextEncoder().encode(value.toUpperCase());
      };
    },
  },
});

const worker = createWorker({
  id: "example-worker",
  transport,
  capacity: 1,
  hostCalls: { maxConcurrent: 1 },
  workloads: {
    "example.task": async ({ input, callHost }) => {
      const call = await callHost({
        workload: "example.uppercase",
        body: input,
      });
      const result = await new Response(call.output).text();
      await call.completed;
      return new TextEncoder().encode(result);
    },
  },
});

try {
  await worker.ready;
  const work = await hypervisor.dispatch({
    workload: "example.task",
    body: new TextEncoder().encode("hello"),
  });
  console.log(await new Response(work.output).text()); // HELLO
  await work.completed;
} finally {
  await worker.stop();
  await hypervisor.shutdown();
}
```

For WebSocket placement, retain the same call and admission code and configure
the usual authenticated Worker transport/lifecycle. Calls use that connection;
there is no additional listener, alternate endpoint, or workload fallback.

## What the host authenticates

`WorkerWorkContext.callHost(input)` binds the call to that exact started work
assignment. Callers cannot supply a parent through `HostCallInput`. The host
resolves the wire parent ID against its own current session and dispatcher:

- `WorkerCallContext.fence` and `definition` come from authenticated host state
- `parent.operationId`, `streamId`, `workload`, and `metadata` come from the
  current, started assignment on that connection
- Missing, unstarted, terminal, foreign-connection, and stale parents are
  refused
- Session and parent validity are checked before admission and again immediately
  before handler entry
- Parent termination, cancellation, connection loss, and session replacement
  abort the call's signal

The call's `workload` and `metadata` are worker-supplied input. A host-derived
assignment is evidence of that assignment, not blanket permission to mutate
application data. Applications must validate their grants, owner/execution
binding, forwarded-client authority, and current mutation fence. Revalidate
transactional authority at the actual application transaction boundary rather
than relying on an earlier admission check.

`workerCalls.admit(context)` may return a handler asynchronously, or return
`undefined` to refuse. The handler receives `{ input, signal }` and returns the
same byte-stream/result shape as a Worker workload. Admission must only decide
whether to reserve and execute; it must not perform the invocation's effects.
The handler is invoked only after `work.start`.

## Parentless calls and receipt recovery

`worker.callHost(input)` is a separate, parentless capability. These calls are
denied unless the host explicitly supplies `workerCalls.admitUnassigned`. They
are permitted only on a ready connection, not while draining.

An application can use that separately authorized path for narrowly scoped
receipt reads after reconnect. Authenticate the current session's stable worker
identity and the requested owner/logical receipt key. Permission to read a
recorded result does not restore a previous execution's mutation authority. Do
not route arbitrary parentless requests through the assigned-call admission
policy. Oxian provides no built-in receipt schema, lookup, or replay decision.

## Handles, effects, and ambiguous failure

`callHost(input)` returns a `HostCallHandle` with `streamId`, `metadata`,
`output`, `started`, `completed`, and `cancel()`:

- `started` resolves after the worker sends `work.start`; it is not proof that
  the host handler entered or committed
- `metadata` resolves once, before response bytes or normal response completion
- `output` is a credited `ReadableStream<Uint8Array>`
- `completed` resolves on normal transport completion, not durable application
  commit or receipt persistence
- `cancel()` requests cancellation; its return does not certify that an
  uncooperative handler or asynchronous source cleanup has stopped

After both stream halves finish successfully, `cancel()` and cancellation of
unread output are harmless to the transport and its other calls. A one-sided
half-close is still cancellable. Application-level refusal carried in a normal
response does not change this transport completion boundary.

`HostCallError`, `createHostCallError`, and `isHostCallError` are exported from
`oxianjs/work` and the package root. Use the guard to identify these errors;
`HostCallError` is a type rather than a class constructor. Its `execution` is
`not_started` before a start can be sent and `indeterminate` once the worker
attempts to send `work.start`. A send failure can still follow physical
delivery, so it remains indeterminate. Inspect `execution`, not just an error
code such as `refused`, when deciding whether effects could have run. Recognized
remote codes are preserved, including `handler_failed`, `deadline_exceeded`,
`cancelled`, and `payload_too_large`; unknown remote codes map to `refused`.

Oxian never retries or replays these calls automatically, including after
reconnect. For an indeterminate result, recover the application's durable
receipt using its stable logical identity before deciding what to do next.
Application idempotency, transactions, and external-effect reconciliation are
not supplied by transport completion.

## Owner-side handles for long-lived resources

Copilotz can implement long-lived resources with ordinary `open/use/close` calls.
The owner keeps the database connection, snapshot, writer, or transaction state
and returns an opaque handle; the worker holds only that handle. Serialize use
per resource, bound resource counts, and bind each handle to the authenticated
owner identity/epoch, execution attempt, parent assignment, and session.

Enforce both idle expiry and an absolute lifetime. Close resources explicitly on
cancel, parent termination, disconnect, and owner takeover, as well as on normal
`close`. A completed opening RPC has released its transport reservation and timer;
these do not bound resources retained between calls. Cancelling that completed
RPC is deliberately harmless, so resource cleanup needs its own owner lifecycle
hooks. Reconnect must not revive old handles. Separately authorized receipt reads
can recover outcomes without restoring old mutation authority.

Copilotz owns this resource registry and cleanup. It must authenticate owner
bindings and check the current owner epoch inside every mutation transaction;
Oxian session fencing alone cannot fence a database owner takeover.

## Bounds, drain, and source ownership

Reverse calls have capacity separate from forward Worker executions, so a
running Worker can make a host call while its ordinary execution capacity is
full. Reverse calls do not enter the ordinary dispatch queue: exhaustion refuses
immediately. A local limit produces `capacity`; remote admission may produce
`refused`. Applications must not create unbounded retry loops.

| Option                                    |                Default |     Accepted range |
| ----------------------------------------- | ---------------------: | -----------------: |
| Hypervisor `workerCalls.maxConcurrent`    |                     32 |           1–65,536 |
| Hypervisor `workerCalls.maxPerConnection` | min(16, maxConcurrent) |            1–1,024 |
| Hypervisor `workerCalls.maxRequestBytes` |                 16 MiB | 1–MAX_SAFE_INTEGER |
| Hypervisor `workerCalls.maxResponseBytes` |                16 MiB | 1–MAX_SAFE_INTEGER |
| Worker `hostCalls.maxConcurrent`          |                     16 |            1–1,024 |
| Either side's `timeoutMs`                 |              30,000 ms | 1–2,147,483,647 ms |

The negotiated per-connection limit is the smaller peer offer/acknowledgement,
including cancelled host handlers whose execution or cleanup has not settled.
Each side enforces its timeout, and `deadlineAtMs` can shorten the call.
Deadlines are checked again at admission/start boundaries. Timeout and abort
signals cannot forcibly terminate arbitrary JavaScript promises: admission,
handler, and source-cleanup reservations stay occupied until that work actually
settles, including across connection replacement. Further work is refused rather
than oversubscribing those limits.

During drain, an existing active assignment may make parent-bound host calls
needed to finish its work. New forward work and parentless host calls are
refused. Graceful Worker drain waits for reverse streams and outstanding
outgoing source cleanup; existing bounded drain/shutdown deadlines still apply.

After a call returns its handle, the channel owns its request source until
completion or cancellation. Do not lock or reuse that stream concurrently. A
rejected call that never returns a handle leaves source ownership with the
caller. Each streamed chunk must be at most 1 MiB; a direct `Uint8Array` may be
larger and is split into wire frames. Metadata and byte-credit bounds are the
ordinary v1 limits. The host counts cumulative raw body bytes independently in
each direction; exceeding `maxRequestBytes` or `maxResponseBytes` aborts only that
call with `payload_too_large`. Limits apply across chunks, including discarded
request bytes after the handler cancels its input consumer. An over-limit
response chunk is not sent. Earlier chunks may already have been processed;
abort does not imply rollback. These limits do not bound decoded/expanded data,
application allocations, or resources retained between calls: callers and host
handlers must bound those separately.

The host may cancel its local request-body consumer without cancelling its
response. A complete early response stops the remaining request upload.
Cancelling the worker's response consumer requests whole-call abort. Source
cancellation can remain pending after the wire stream closes; its reservation is
not released early.

## Optional v1 negotiation

The protocol identifier stays `oxian.worker.v1`. The reserved transport key
`__oxian_worker_calls_v1` carries `{ version: 1, capacity: N }` in
`Welcome.bootstrap` and `Ready.metadata`, with integer `N` from 1 through 1,024.
The optional `maxLifetimeStreams` field is an integer from 1 through 65,536;
omission means 65,536. Current runtimes send this field and acknowledge the
smaller offered/local lifetime limit.
The worker acknowledges no more than the host offered. Missing acknowledgement
leaves the connection ordinary-only. A malformed capability, unsolicited
acknowledgement, or acknowledgement above the offer fails closed. Activation
waits for `ReadyAck`.

Application bootstrap and Ready metadata must not define that reserved key. The
runtime adds it on wire and strips it before application callbacks. Old peers
remain usable for ordinary work; an unnegotiated connection cannot carry
worker-originated opens. Reverse calls share the existing credit/sequence,
half-close, abort, no-ID-reuse, and total connection lifetime limits. On negotiated connections, the host owns
ceil(lifetime / 2) Opens and the worker owns floor(lifetime / 2). Fixed shares
prevent crossed Opens from overspending the total budget. Queued local Opens
reserve slots immediately. Exhausting either share starts host-driven rotation;
the other share remains usable by existing parent assignments during drain.
An exhausted worker rejects locally with `capacity/not_started`, before Open.
A lifetime of one leaves no reverse slots. Unnegotiated connections retain the
entire ordinary forward budget. Calls are never replayed during rotation.

See the
[wire contract](worker-protocol-v1.md#optional-worker-to-host-invocation),
[Hypervisor API](api/hypervisor.md#worker-to-host-admission),
[Worker API](api/worker.md#host-calls), and
[call types](api/work.md#host-calls).
