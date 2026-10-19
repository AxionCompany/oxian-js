# API reference

This reference covers the public API of `@oxian/oxian-js` version `0.22.0`.
Start with the [getting-started guide](getting-started.md) when learning Oxian;
use these pages when composing a runtime, implementing a platform boundary, or
checking an exact contract.

## Imports

The package root is the side-effect-free, runtime-neutral execution core:

```ts
import {
  createApplication,
  createHypervisor,
  createWorker,
} from "jsr:@oxian/oxian-js@0.22.0";
```

Explicit subpaths make ownership clearer and keep the executable boundary out of
application code:

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.22.0/app";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.22.0/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.22.0/adapters/deno";
import { createWorker } from "jsr:@oxian/oxian-js@0.22.0/worker";
```

The root excludes filesystem discovery, static files, local processes, local
runtime composition, server adapters, `/cli`, and `/bin`. Import those explicit
subpaths only when the target runtime provides the required capability.

## Application modules

| Subpath                    | Use it to                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`/app`](api/app.md)       | Create a Fetch-native application, compose middleware, load an application factory, and produce server-sent events. |
| [`/config`](api/config.md) | Define, validate, and load the data-only Oxian configuration.                                                       |
| [`/router`](api/router.md) | Compile a filesystem route tree once and match requests in memory.                                                  |
| [`/edge`](api/edge.md)     | Add CORS, static-file, and development-proxy adapters around a Fetch handler.                                       |

## Execution and transport modules

| Subpath                            | Use it to                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`/http`](api/http.md)             | Encode HTTP metadata and bodies, create the gateway, or run an HTTP workload inside a worker.                      |
| [`/hypervisor`](api/hypervisor.md) | Host in-process and remote Workers, dispatch work, drain, and inspect process-local state without owning a server. |
| [`/worker`](api/worker.md)         | Declare workloads and bind a Worker through an in-process or WebSocket transport descriptor.                       |
| [`/work`](api/work.md)             | Use the minimal runtime-neutral work input, stream handle, and dispatch capability contracts.                      |
| [`/transport`](api/transport.md)   | Open the worker WebSocket transport or provide a custom socket factory.                                            |
| [`/protocol`](api/protocol.md)     | Build, validate, and interpret `oxian.worker.v1` control and binary frames.                                        |

## Platform and local-runtime modules

| Subpath                                  | Use it to                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`/adapters/deno`](api/adapters/deno.md) | Add Deno WebSocket upgrade and optional `Deno.serve` listener ownership around the portable Hypervisor core.                                              |
| [`/adapters/node`](api/adapters/node.md) | Add a Node `node:http` listener with WebSocket upgrades around the portable Hypervisor core.                                                              |
| [`/providers`](api/providers.md)         | Provision, inspect, and terminate compute without coupling compute presence to transport readiness.                                                       |
| [`/local`](api/local.md)                 | Compose the development runtime, run manifest-defined workers, and store local credentials.                                                               |
| [`/cli`](api/cli.md)                     | Parse or execute the six Oxian commands without terminating the host process. The same page documents the [`/bin`](api/cli.md#executable-bin) entrypoint. |

## Dispatch capacity

Hypervisor dispatch supports opt-in bounded waiting via
`HypervisorConfig.maxQueuedDispatches` and `dispatchQueueTimeoutMs`. Waiting
covers full capacity and absent/reconnecting targets, with FIFO scheduling,
deadline/abort handling, queue-full backpressure, and queue counts in
`HypervisorSnapshot`. The default queue limit is zero for 0.21 compatibility.
The configured timeout covers entry-to-Open and both dispatch hooks in either
mode. `maxPendingDispatchHooks` separately bounds unsettled callbacks; their
occupancy remains visible after a caller timeout until actual settlement.
An `assign` callback selects an exact current session fence. If that session is
replaced before the callback resolves, immediate dispatch refuses with
`worker_unavailable`; queued dispatch may select afresh. An explicit
`target.workerId` without a callback selection still names the logical worker.
See the [Hypervisor API](api/hypervisor.md#dispatch-waiting) and
[operations guide](operations.md#bounded-dispatch-waiting).

## Optional worker-to-host calls

Enable `HypervisorOptions.workerCalls` with explicit admission policy for
assignment-bound `WorkerWorkContext.callHost`. Parentless `Worker.callHost`
requires separate default-denied admission. The `/work` subpath provides
`HostCaller`, streaming handles, and errors with not-started/indeterminate
execution classification. See the [call guide](worker-host-calls.md) for
host-derived authority evidence and application-owned receipt recovery.

Supporting workers acknowledge host calls automatically; `WorkerOptions.hostCalls`
only configures limits. See [owner-side handles](worker-host-calls.md#owner-side-handles-for-long-lived-resources)
for application-owned resource lifecycle guidance.

## Shared conventions

### Fetch-native boundaries

Application and edge APIs use native `Request`, `Response`, `Headers`,
`ReadableStream`, and `AbortSignal`. Oxian does not introduce parallel HTTP
request or response classes.

### Closure-based capabilities

Public stateful APIs are closure factories rather than classes. They return
frozen records of functions and snapshots; Oxian does not expose constructors or
`this`-managed objects. Transport variants are visible discriminated records,
such as `{ type: "in-process", config: { topic: "orders" } }`; they do not
require named construction helpers. Callers should await lifecycle promises and
must not infer readiness merely from the presence of provider compute.

### Read-only contracts

Configuration, protocol frames, descriptors, snapshots, and most option bags are
typed as `Readonly`. Treat returned snapshots as observations, not mutable
control surfaces.

### Cancellation and deadlines

I/O APIs accept `AbortSignal` or deadline options at the boundary that owns the
operation. Cancellation stops local work; it does not weaken the post-acceptance
no-replay rule.

### Errors and protocol violations

Programmer input and invalid configuration normally fail by throwing. Runtime
protocol faults use the typed violation and close-code contracts documented by
[`/protocol`](api/protocol.md). Lifecycle methods that return promises surface
terminal failures through rejection or their documented result types.

## Process and durability boundary

A Hypervisor owns only the in-process and WebSocket Worker sessions attached to
that process. Applications close `activate`, `register`, `admit`, and lifecycle
callbacks over their own repositories or credential services; Oxian does not
force those domain concepts into manager objects. Applications that require a
distributed socket-owner directory, durable acceptance, result persistence, or
cross-replica forwarding own those policies outside the package.

See [runtime boundaries and adapters](runtime-adapters.md) for the supported
runtime matrix and the `FrameConnection` seam.

Every Worker, including an in-process Worker, sends `work.accepted` before
workload execution. Once the Hypervisor's acceptance callback confirms the
no-replay boundary and `work.start` is sent, Oxian does not replay that
operation after an indeterminate failure. See the
[normative worker protocol](worker-protocol-v1.md) for the complete state
machine.

## CLI summary

```text
oxian init [--root PATH] [--force]
oxian dev [--config FILE] [--hostname HOST] [--port PORT]
oxian start [--config FILE] [--hostname HOST] [--port PORT]
oxian worker [--manifest FILE]
oxian routes [--config FILE]
oxian check [--config FILE]
```

`runCli(args)` returns an exit code and never calls `Deno.exit()`. The
executable entrypoint assigns `Deno.exitCode` and owns `SIGINT` and `SIGTERM`.
See the [CLI API](api/cli.md) for parsing, dependency injection, command
behavior, and exit-code semantics.
