# Runtime boundaries and adapters

The Oxian core is runtime-neutral. Importing the package root does not read a
filesystem, spawn a process, bind a listener, or install process signals.

## Layering

```text
application policy
  activate / register / admit / assign / lifecycle callbacks
                         │
Worker + Hypervisor shared lifecycle kernels
                         │
oxian.worker.v1 codec, order, credit, bounded FrameConnection
                    ┌────┴────┐
addressed local fabric      native WebSocket adapter
                    │           │
                 same realm   Deno / Node / Bun / browser / edge runtime
```

Runtime adapters only acquire or expose physical resources. They do not
implement Worker lifecycle transitions.

## Deno

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.6";
import { handler, serve } from "jsr:@oxian/oxian-js@0.21.0-rc.6/adapters/deno";

const hypervisor = createHypervisor({
  transports: [{
    type: "websocket",
    config: { path: "/_oxian/workers/connect" },
  }],
  admit,
});

// Compose into an app-owned server:
const fetch = handler(hypervisor);

// Or let this explicit adapter own Deno.serve:
const listener = serve({ hypervisor, port: 8080 });
```

`handler()` owns `Deno.upgradeWebSocket`, selects the v1 subprotocol, adapts the
native socket, and attaches it exactly once to the Hypervisor's prepared upgrade
decision. `serve()` owns only its listener; it never creates or shuts down the
supplied Hypervisor.

## Other server runtimes

A server adapter follows the same sequence:

1. Call `hypervisor.prepare(request)`.
2. Return a normal response when `kind === "response"`.
3. For `kind === "upgrade"`, negotiate `decision.protocol`.
4. Adapt the native connection to `SocketConnection`.
5. Call `decision.attach(connection, negotiatedProtocol)` exactly once.
6. Call `decision.cancel(reason)` if native upgrade fails.

`SocketConnection` is callback-based because some runtimes deliver WebSocket
events at the server object rather than through a DOM `EventTarget`. The
`adaptWebSocket`, `adaptSocketConnection`, `isSocketConnection`, and
`expectSocketConnection` utilities cover standards-compatible and custom runtime
sockets.

`createFrameConnection` then normalizes callbacks to the bounded Web Stream
contract. Lifecycle code sees only `FrameConnection`, `Frame`,
`FrameSendOptions`, `FrameConnectionOptions`, and `ConnectionClose`.

## Outbound Worker sockets

Workers use their declarative `transport.config.url`. Advanced integrations may
provide `transport.config.socket`, a `WorkerWebSocketFactory`, to acquire a
provider token and create the native socket. The `WorkerWebSocketFactoryContext`
contains a validated URL, exact protocol, and deadline signal.

`connectWorkerWebSocket(ConnectWorkerWebSocketOptions)` is the lower-level WSS
acquisition utility. It verifies URL policy, deadline, Open, and subprotocol.
The public Worker factory normally owns this call.

## In-process binding

No runtime API is required. The Hypervisor transport declaration registers one
same-realm addressed event fabric by `config.topic`; a Worker declaration
rendezvous with that fabric. Local publications normalize to the same frame
stream and run the same protocol kernel as WSS.

The local path does not expose the internal binding. Hypervisor shutdown owns
its unregistration. Avoid process-global implicit topics; choose an explicit
unique name per embedded engine/session when isolation matters.

## Core portability

The root and execution core rely on web-platform primitives available in Deno,
Node, Bun, browsers, and edge runtimes:

- `Request`, `Response`, `Headers`, and `URL`;
- `ReadableStream` and `Uint8Array`;
- `AbortController` and `AbortSignal`;
- `crypto.randomUUID()`; and
- timers.

Filesystem routing, static serving, CLI behavior, local credential files,
`Deno.Command`, and `Deno.serve` live in explicit subpaths. Import only the
adapter supported by the target runtime.

## Ownership rule

A component closes only resources it created. Injected Hypervisors, dispatchers,
providers, listeners, and transports remain application-owned unless their
contract explicitly transfers ownership. This rule is identical for embedded and
server deployments.
