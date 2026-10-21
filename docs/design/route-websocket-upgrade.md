# Route WebSocket upgrades

## Current state (0.22.0)

- `src/hypervisor/hypervisor.ts:402-420` sends non-worker paths to the Fetch
  fallback. Worker socket admission remains a separate reserved path.
- `src/http/gateway.ts:124-151` serializes requests and dispatches HTTP work.
  `src/hypervisor/internal/work-stream.ts:887-940` creates credit-controlled
  input/output streams; `:955-966` sends the work-open metadata.
- `src/worker/session.ts:918-988` invokes the workload and publishes metadata.
  `src/http/workload.ts:22-67` rebuilds the Request, invokes Fetch, and
  serializes the response. `src/http/metadata.ts:194-203` correctly rejects
  status 101 in ordinary HTTP metadata.
- `src/adapters/deno/server.ts:15-38` and `src/adapters/node/server.ts:125-147`
  perform the internal worker socket handshake after synchronous admission.
  Neither awaits route acceptance.
- `src/adapters/node/connection-budget.ts:2-60` caps live sockets at 1,000.
  `src/adapters/node/connection-budget.test.ts:43-94` proves shared budgets and
  release on refused upgrades. Application sockets must use the same budget.
- The separately inspected app facade (`server/facade.ts:614-633`) selects an
  injected host upgrade function, installs its socket handler, and returns the
  host response unchanged. Its Node host buffers early frames until Fetch
  completes (`runtime/adapters/node/device-upgrade.ts:18-120`). Its host hook is
  a module-private Request-keyed WeakMap
  (`runtime/subscriptions/hosting.ts:12-29`), not a public cross-library host
  protocol. Oxian cannot populate another package's private map. The supplied
  facade revision has no automatic native-runtime fallback. This is an
  integration constraint, not something relaxing status validation can fix.

## Decision

Use upgrade-aware workloads (a). Application state and execution stay with the
selected worker, including remotely attached workers. A long-lived upgrade holds
one execution reservation. Reuse the existing bidirectional work streams, credit
windows, cancellation, fencing, and worker-loss handling. Do not add a second
worker connection or a new worker wire protocol.

The HTTP request metadata remains unchanged inside a distinct upgrade envelope.
Include trusted listener client-address metadata separately from headers. The
worker receives original method, URL and Headers, without rewriting Origin,
Cookie, Host, or offered protocols. Refusal uses ordinary HTTP response
metadata; acceptance uses an explicitly validated upgrade schema. A bare HTTP
101 remains invalid. The native client handshake happens only after acceptance.

Frames use a bounded length-prefixed message envelope over work bytes: text,
binary, and close. Stream chunks are not message boundaries. Bound assembled
messages, queued messages/bytes, and native send buffers. Close overload with
1009; cancel/loss with 1011; preserve valid peer close codes and reasons. No
unbounded promise chains or application message queues.

## Public API

Add portable `upgradeWebSocket(request, { protocol? })` returning
`{ socket, response }`, plus `getClientAddress(request)`. The socket follows the
standard event/send/close contract. Return the response unchanged, after any
asynchronous admission work. The response is an opaque acceptance capability,
not an ordinary HTTP response to clone or synthesize.

Server adapters resolve this capability after awaiting fallback responses;
`Hypervisor.prepare` stays synchronous and worker admission stays unchanged.
HTTP gateway/workload factories automatically recognize upgrade requests. A Deno
workload adapter additionally consumes native `Deno.upgradeWebSocket` responses
through a private loopback native host, preserving handlers that already call
the native API. It must not monkey-patch globals or inspect native private
symbols. Node routes use the portable host operation.

A new additive API requires an unreleased 0.23.0 changelog entry; package
versions stay at 0.22.0. No feature flag or transport-specific route
registration.

## Deletions

Replace the HTTP-only gateway/workload branch for upgrade requests; keep
ordinary HTTP metadata validation and all worker protocol mechanisms. Move
connection budget implementation to a portable boundary, retaining Node exports.

## Guarantees and validation

- Real listeners, both adapters and worker transports: text and binary echo,
  selected protocol, original request headers/URL and client address, refusal,
  ordinary HTTP, early frames, both close directions, worker loss.
- Bounded message decoder: fragmented stream chunks, oversize lengths, malformed
  types/UTF-8/close payloads, queue byte/count exhaustion, send-buffer
  exhaustion.
- Shared socket budgets: accepted sockets hold a lease; refused and closed
  sockets release it; shutdown closes live sockets.
- Local start/dev: native Deno echo, both transports; reload closes old sockets.
- Run targeted tests while developing, then full Deno and Node checks/tests.

## Risks and limits to verify

Deno's public native WebSocket API exposes complete messages, not fragments or a
configurable inbound reassembly cap. Application queue bounds cannot claim to
bound allocation inside the native runtime. Node's native parser must enforce
maxPayload before delivery. Deno native compatibility adds a private loopback
connection per accepted route; it is owned and cancelled with the workload.

The inspected facade's private host registration cannot be supplied generically
by Oxian. An app that already supplies a native upgrade callback can remain
unchanged on Deno; a facade needing private adapter registration requires its
own host integration to select the portable operation. Do not claim that this
revision of the facade works unchanged without an executable proof.

## Verification and outstanding integration

Real-socket cases cover both listener adapters, both worker transports, and
native Deno handlers. They cover fragmented and outbound oversize messages,
close during handshake opening, and cancellation of one work-stream half while
the peer close is queued in the other half. CLI probes cover native echo under
start/dev with each transport and stop/restart with a live socket (1011).

The current CLI is Deno-bound; Node listener/worker deployments are tested via
library composition. There is no existing automatic file hot reload to exercise.
An unchanged-facade end-to-end claim remains unproven: its private host registry
requires integration in that package or an already supplied upgrade callback.
Deno native reassembly remains outside the enforceable public API limits.
