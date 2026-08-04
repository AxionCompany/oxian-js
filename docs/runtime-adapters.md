# Runtime boundaries and adapters

Oxian's package root is the runtime-neutral execution core. Importing it does
not load filesystem discovery, local process management, an HTTP listener, or a
runtime-specific server API.

## Current support

| Capability                       | Deno                                  | Node 22+                  | Bun                       | Cloudflare/browser       |
| -------------------------------- | ------------------------------------- | ------------------------- | ------------------------- | ------------------------ |
| Portable package root            | Supported                             | Verified in CI            | Web-API-compatible core   | Web-API-compatible core  |
| Embedded `WorkerHost`            | Supported                             | Verified in CI            | Supported by core         | Isolate/event-loop local |
| HTTP workload and Web Streams    | Supported                             | Verified in CI            | Supported by core         | Supported by core        |
| Hypervisor protocol/session core | Supported                             | Adapter-ready             | Adapter-ready             | Adapter-ready            |
| Hypervisor WebSocket server      | `/adapters/deno`                      | Not yet published         | Not yet published         | Not yet published        |
| Filesystem routes/static/process | Existing explicit Deno-facing modules | Future capability adapter | Future capability adapter | Build/binding adapters   |

“Adapter-ready” means the core no longer depends on Deno's upgrade or listener
APIs. It does not claim that a server adapter for that runtime is already part
of this release candidate.

Automated verification currently covers the complete Deno composition and the
portable root under Node. The Bun and Cloudflare/browser core entries describe
standards-compatible boundaries, not a support guarantee; each runtime still
needs its own adapter and conformance job before Oxian can make that claim.

## Connection seam

`Hypervisor.prepare(request)` returns either a normal HTTP response decision or
a one-shot WebSocket upgrade admission. A server adapter performs its native
handshake and attaches a `WorkerWireConnection`.

```text
request -> Hypervisor.prepare
                 |
                 +-- response -> return without upgrading
                 |
                 +-- upgrade admission
                        -> runtime-native handshake
                        -> WorkerWireConnection
                        -> protocol/session core
```

`WorkerWireConnection` is callback-based instead of extending `EventTarget`.
This lets adapters represent DOM WebSockets, Bun server callbacks, Node upgrade
libraries, and Cloudflare Durable Object callbacks without leaking any of them
into protocol state.

The admission reserves capacity before the native upgrade. The adapter must call
exactly one of `attach(connection)` or `cancel()`. An unconsumed admission
expires on the configured handshake deadline.

## In-process workers

`WorkerHost` continues to pass live `ReadableStream<Uint8Array>` values
directly. It does not serialize operations through `WorkerWireConnection` or
JavaScript payload events. This preserves the lighter in-process path while the
remote Hypervisor keeps its protocol and isolation boundary.

## Runtime-specific imports

Use explicit subpaths for capabilities:

```ts
import { createWorkerHost } from "jsr:@oxian/oxian-js@0.20.0-rc.6";
import { createDenoHypervisor } from "jsr:@oxian/oxian-js@0.20.0-rc.6/adapters/deno";
import { createFileRouter } from "jsr:@oxian/oxian-js@0.20.0-rc.6/router";
import { createLocalProcessProvider } from "jsr:@oxian/oxian-js@0.20.0-rc.6/providers";
```

The root deliberately excludes `createFileRouter`, `createLocalRuntime`,
`createLocalProcessProvider`, and Deno adapters. This keeps unsupported
capabilities out of Node, Bun, Worker, and browser bundles.

## Verification

`deno task check:portability` follows every relative import in the root/core
dependency closure and rejects Deno, Bun, Node builtin, Cloudflare-runtime, or
`@std` dependencies. CI also imports the root and executes an in-process stream
plus HTTP workload under supported Node versions.
