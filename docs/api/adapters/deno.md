# `jsr:@oxian/oxian-js@0.23.2/adapters/deno`

This explicit runtime adapter owns Deno's native WebSocket upgrade and optional
HTTP listener boundary. It never creates or shuts down an injected Hypervisor.

Exports: `handler`, `serve`, and `DenoServeOptions`.

## Compose a handler

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.23.2/hypervisor";
import { handler } from "jsr:@oxian/oxian-js@0.23.2/adapters/deno";

const hypervisor = createHypervisor({
  transports: [{
    type: "websocket",
    config: { path: "/_oxian/workers/connect" },
  }],
  admit,
});

Deno.serve(handler(hypervisor));
```

`handler(hypervisor)` calls `hypervisor.prepare()`, performs
`Deno.upgradeWebSocket`, negotiates the exact protocol, adapts the native
socket, and attaches it once. Other requests use the Hypervisor fallback.

## Own a listener

```ts
import { serve } from "jsr:@oxian/oxian-js@0.23.2/adapters/deno";

const listener = serve({ hypervisor, hostname: "0.0.0.0", port: 8080 });
await listener.finished;
```

`serve(options: DenoServeOptions)` returns a `HypervisorListener` with resolved
address, URL, `finished`, and idempotent `shutdown()`. An optional signal closes
only this listener.

Call `hypervisor.shutdown()` separately in the application layer that owns it.

## Route upgrades (unreleased)

The adapter awaits asynchronous route acceptance before upgrading. Pending and
accepted WebSockets share a connection budget; `DenoServeOptions.budget` can
share the `/http` budget with other listeners. Listener shutdown closes route
sockets. The legacy Deno HTTP request abort on upgrade is detached before native
upgrade; subsequent socket events own the connection lifetime.

`hostWebSocket` is a native workload host for routes calling
`Deno.upgradeWebSocket` directly. Supply it as
`createHttpWorkload({ fetch: application.fetch, hostWebSocket })` on custom Deno
workers. Local and manifest runtimes install it automatically. It creates a
private loopback native request, exposes the original public request fields to
the route, and bridges accepted messages into the bounded worker stream. This
requires loopback listen/connect permissions. It does not patch globals or read
runtime private symbols. Portable `upgradeWebSocket` routes work without this
host hook.

Deno native messages are size-checked after delivery. Its public API has no
preallocation reassembly limit; use the Node listener for that guarantee.
