# oxianjs

## 0.23.0

- Fix CLI shutdown after abrupt WebSocket disconnection or use of the WebSocket
  worker transport. Disable Deno's retained native idle timers on listener-owned
  upgrades; worker heartbeat/lease checks remain active. Both listeners allow a
  250 ms close handshake before forcing remaining connections closed. Native
  Deno route hosts close their private peers gracefully with the same bound.
  Shutdown awaits resource cleanup and app disposal without forcing process
  exit.

- Add portable route WebSocket acceptance and peer-address access, with delayed
  client handshakes, refusal statuses, text/binary messages, close propagation,
  bounded work-stream envelopes, and worker-lifetime cancellation.
- Support both worker transports and both listener adapters. Share connection
  budgets across pending upgrades, route sockets and worker sockets.
- Host native Deno upgrade routes in local and manifest runtimes. Ordinary HTTP
  metadata remains strict; status 101 is only an upgrade acceptance.
- Node enforces inbound fragmented-message bounds. Deno native delivery is
  bounded after reassembly; its public API cannot cap native reassembly memory.

## 0.22.0

### Minor Changes

- Breaking: remove the unused generic owner, owner-host and Postgres-owner APIs.
  Durable ownership moves to the concrete Copilotz runtime, which provides it.

  Retain worker dispatch, transports, sessions and independent Node connection
  budgeting. Publish the existing Node-portable root and explicit subpaths, with
  installed-package type and in-process/WebSocket proofs; remove the owner-only
  PostgreSQL dependency and CI service.

- Expose the existing configuration and application-factory APIs at
  `oxianjs/config` and `oxianjs/app` in the Node package. Keep signatures,
  validation and local TypeScript-module loading unchanged, using internal Node
  path/URL adapters while retaining Deno compatibility and the portable root.

- Expose the existing file-router API at `oxianjs/router` in the Node package.
  Use Node filesystem, path and URL APIs through an internal adapter, retaining
  Deno compatibility, deterministic discovery, symlink exclusion, startup
  validation and synchronous pathname matching. Keep the package root portable.

- Add host-enabled worker-to-host invocation over the existing in-process and
  WebSocket worker connection. Negotiate bounded reverse streams through
  reserved v1 handshake metadata; retain ordinary-only compatibility for peers
  that do not acknowledge the extension.

  Expose assignment-bound `WorkerWorkContext.callHost`, separately default-
  denied `Worker.callHost`, host admission callbacks, streaming call handles,
  and `HostCallError.execution` for not-started versus indeterminate outcomes.
  Preserve independent capacity, session/parent fencing, cancellation, source
  cleanup, drain, and reconnect limits without automatic replay. Durable owner
  transactions, authorization, receipts, and recovery remain application- owned.

### Patch Changes

- Bound assign and onWorkAssigned callbacks with one shared entry-to-Open
  deadline in both dispatch queue modes. The existing dispatchQueueTimeoutMs now
  includes these hooks; it still does not limit execution after Open. Add a
  separate maxPendingDispatchHooks budget and pendingDispatchHooks snapshot
  count.

  Caller cancellation, timeout, drain and session replacement refuse promptly,
  while noncooperative hooks retain their occupancy until actual settlement.
  Assigned-but-unopened work retains its reservation until callback settlement
  or session loss and cannot open late. Preserve ordinary worker/queue and
  reverse call capacity independently.

- Make cancellation of a fully completed reverse call harmless. Late handle or
  unread-output cancellation no longer emits a post-terminal frame that could
  close the shared connection and interrupt parent or sibling work. Preserve
  one-sided half-close cancellation and deferred source cleanup.

- Expose immutable, protocol-validated worker-call capability agreement on the
  Hypervisor Ready context. Hosts can reject missing support in the existing
  awaited readiness callback before routability and ReadyAck, without trusting
  application metadata or changing ordinary-only worker behavior.

- Propagate premature Node HTTP disconnects through Request.signal, including
  unfinished request bodies, responses and Upgrade fallbacks. Preserve normal
  body completion and keep-alive request isolation so the existing HTTP gateway
  can cancel assigned work and release execution capacity.

- Handle Node listener startup failures and cancellation without unhandled
  completion rejections or taking ownership of the supplied Hypervisor.

- Preserve Node listener Response metadata across HTTP fallback and rejected
  WebSocket upgrades, including custom status text, authentication/retry
  headers, and repeated cookies. Validate rejection headers before writing and
  keep connection/body framing transport-owned.

- Close pending HTTP Upgrade sockets during Node listener shutdown, including
  requests waiting on an application fallback or its response body. Release the
  shared connection lease on socket close and prevent late response writes.

- Reject stale asynchronous assign selections when dispatch waiting is disabled.
  An exact selected session can no longer silently route work to a replacement
  connection for the same logical worker. Queued selection retry and explicit
  logical-worker targeting retain their existing behavior.

- Automatically acknowledge the versioned worker-to-host capability when
  offered; retain worker capacity/timeout configuration and explicit host
  admission policy. Missing negotiation disables reverse calls with no fallback.

  Negotiate and partition connection lifetime slots between both initiators,
  reserve queued Opens, and rotate when either share is spent without invalid
  Opens or loss of the active parent. Enforce negotiated capacity for unsettled
  host reservations. Preserve recognized remote error codes and conservative
  execution ambiguity.

  Bound aggregate request and response bodies at the host (16 MiB each by
  default, configurable with maxRequestBytes/maxResponseBytes), reporting
  payload_too_large. Document application-owned open/use/close handles, expiry,
  cancellation, termination, disconnect/takeover cleanup, and transactional
  owner fencing.
