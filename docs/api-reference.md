# API reference

This reference covers the public API of `@oxian/oxian-js` version `0.20.0-rc.3`.
Start with the [getting-started guide](getting-started.md) when learning Oxian;
use these pages when composing a runtime, implementing a platform boundary, or
checking an exact contract.

## Imports

The package root is a side-effect-free aggregate of every library module:

```ts
import {
  createApplication,
  createHypervisor,
  createWorkerClient,
} from "jsr:@oxian/oxian-js@0.20.0-rc.3";
```

Explicit subpaths make ownership clearer and keep the executable boundary out of
application code:

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.20.0-rc.3/app";
import { createHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.3/hypervisor";
import { createWorkerClient } from "jsr:@oxian/oxian-js@0.20.0-rc.3/worker";
```

The aggregate root excludes `/cli` and `/bin`. Import `/cli` to embed the
command parser and runner. Execute `/bin` when Oxian should own process exit and
signal handling.

## Application modules

| Subpath                    | Use it to                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`/app`](api/app.md)       | Create a Fetch-native application, compose middleware, load an application factory, and produce server-sent events. |
| [`/config`](api/config.md) | Define, validate, and load the data-only Oxian configuration.                                                       |
| [`/router`](api/router.md) | Compile a filesystem route tree once and match requests in memory.                                                  |
| [`/edge`](api/edge.md)     | Add CORS, static-file, and development-proxy adapters around a Fetch handler.                                       |

## Execution and transport modules

| Subpath                            | Use it to                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [`/http`](api/http.md)             | Encode HTTP metadata and bodies, create the gateway, or run an HTTP workload inside a worker.                   |
| [`/hypervisor`](api/hypervisor.md) | Accept authenticated worker WebSockets, dispatch work, listen for HTTP, drain, and inspect process-local state. |
| [`/worker`](api/worker.md)         | Maintain an outbound worker connection, rotate credentials, heartbeat, reconnect, and execute workloads.        |
| [`/transport`](api/transport.md)   | Open the worker WebSocket transport or provide a custom socket factory.                                         |
| [`/protocol`](api/protocol.md)     | Build, validate, and interpret `oxian.worker.v1` control and binary frames.                                     |

## Platform and local-runtime modules

| Subpath                            | Use it to                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`/supervisor`](api/supervisor.md) | Model worker identity, issue registration attempts, fence sessions, store records, and dispatch against ready sessions.                                   |
| [`/providers`](api/providers.md)   | Provision, inspect, and terminate compute without coupling compute presence to transport readiness.                                                       |
| [`/local`](api/local.md)           | Compose the development runtime, run manifest-defined workers, and store local credentials.                                                               |
| [`/cli`](api/cli.md)               | Parse or execute the six Oxian commands without terminating the host process. The same page documents the [`/bin`](api/cli.md#executable-bin) entrypoint. |

## Shared conventions

### Fetch-native boundaries

Application and edge APIs use native `Request`, `Response`, `Headers`,
`ReadableStream`, and `AbortSignal`. Oxian does not introduce parallel HTTP
request or response classes.

### Factories and lifecycle

Public stateful APIs are factory functions rather than classes. Creation
configures an object; methods such as `start()`, `stop()`, `drain()`, and
`dispose()` own explicit transitions where the returned contract exposes them.
Callers should await lifecycle promises and must not infer readiness merely from
the presence of provider compute.

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

One Hypervisor owns only the worker sessions attached to that process.
Supervisor repositories may persist worker control records, but Oxian does not
provide a distributed socket-owner directory or a durable cross-replica work
relay. Applications that require durable acceptance, result persistence, or
cross-replica forwarding own those policies outside the package.

The worker sends `work.accepted` before workload execution. Once the Hypervisor
persists acceptance and sends `work.start`, Oxian does not replay that operation
after an indeterminate connection loss. See the
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
