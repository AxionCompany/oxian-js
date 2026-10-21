# WebSocket shutdown ownership

## Evidence and current ownership

- `cli.ts:7-33` removes SIGINT/SIGTERM listeners and awaits the command; it sets
  the exit code without forcing process exit.
- `src/local/runtime.ts:169-185` aborts the lifecycle, settles listener,
  hypervisor and worker shutdown, awaits worker completion, then disposes the
  app. This topology starts no subprocess and owns no child pipes.
- `src/adapters/deno/server.ts:90-113` tracks native upgrades until close.
  `:162-192` waits 250 ms for socket closes, then calls unbounded server
  shutdown.
- `src/adapters/node/server.ts:203-226` terminates worker connections and
  destroys tracked upgraded TCP sockets, including pending application
  decisions.
- `src/worker/session.ts:1757-1760,1830-1834` owns and clears heartbeat,
  rotation and drain timers. `src/transport/websocket.ts:91-107,333-335`
  disposes the connection deadline. `src/transport/frame.ts:305-328` removes
  subscriptions.
- `src/adapters/deno/route-websocket.ts:107-118` immediately terminates the
  private native-route client, potentially making the native server see an
  abnormal disconnect instead of a close handshake.
- A standalone Deno 2.9.2 reproduction with no Oxian imports hangs after an
  abrupt WebSocket disconnect and handled SIGTERM. Setting the documented
  `Deno.upgradeWebSocket` option `idleTimeout: 0` makes it exit. Deno's native
  server error path closes its resource but retains its system idle timer;
  ordinary JavaScript timer and resource instrumentation cannot see that timer.
  Source:
  [Deno v2.9.2 WebSocket implementation](https://github.com/denoland/deno/blob/v2.9.2/ext/websocket/01_websocket.js#L821),
  `_eventLoop` error branch and `_serverHandleIdleTimeout`.

## Decision and public API

Disable native automatic ping timers on upgrades owned by the Deno listener.
Worker liveness remains enforced by protocol heartbeats and leases. Route
applications own their application liveness policy. Do not replace the native
idle timer with another hidden interval or inspect runtime-private symbols.

Give listeners a bounded close handshake window (250 ms). Stop admission and
abort pending upgrade decisions immediately; send close frames; force-close
remaining physical resources at the deadline. Deno uses its server AbortSignal;
Node destroys the tracked TCP sockets. Clear the deadline when cleanup finishes.
The native-route compatibility host should close its private client gracefully
before the bounded terminate/abort fallback, and await cleanup when applicable.

No public API, version, worker wire format or process-exit changes. Keep local
application disposal and worker execution settlement guarantees. No automatic
file watcher exists in the CLI; dev uses the same owned lifecycle as start.

## Deletions and validation

Replace unbounded listener shutdown and immediate private-client termination.
Keep existing timer cleanup, budget accounting and provider subprocess cleanup.

Subprocess regression tests must run the real CLI start/dev, both worker
transports, portable/native echo, abrupt client termination and SIGTERM,
asserting exit status zero and disposal within a fixed bound. Node listener
composition gets the same subprocess proof, including a peer that ignores the
close handshake and an upgrade still awaiting acceptance. Test-owned watchdogs
kill only failing children and are cleared on success. Run the full Deno and
Node suites/checks and record the manual probe transcript separately.

## Risks

Deno does not expose terminate on individual native WebSockets; server abort is
its supported forced resource boundary. Native routes that explicitly create
Deno sockets also own their native idle policy. Avoid causing abnormal private
peer termination during normal cleanup, and verify this path with native-route
subprocesses. Application callbacks that never settle remain application-owned;
shutdown must not falsely report their execution as drained.

## Completed verification

The new subprocess suite passes 20 cases under each test runner: CLI start/dev,
portable/native route acceptance, both worker transports, plus Node listener
composition. Abrupt peers exit in 13–28 ms after SIGTERM; peers that cannot read
a Close frame and simultaneous pending upgrades exit in 259–263 ms. Each test
asserts a zero OS exit status, application disposal and a three-second bound.
Removing only `idleTimeout: 0` in an isolated copy makes the regression fail
after printing the disposal marker. The supplied minimal standalone reproduction
also exits with code zero after the fix.

The existing local-process provider allows only inherited/null stdio
(`src/providers/local_process.ts:150-161`), so it owns no child pipes. Its
termination path already bounds graceful/forced process termination
(`:501-550`). Local start/dev does not instantiate that provider. Hypervisor
shutdown clears lease sweeps (`src/hypervisor/hypervisor.ts:467-498`), and
connection retirement cancels handshake/attachment/readiness/drain/age timers
(`src/hypervisor/internal/lifecycle.ts:77-81`). No extra interval cleanup or
process-exit override was necessary.
