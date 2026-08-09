# `jsr:@oxian/oxian-js@0.21.0-rc.1/adapters/deno`

This explicit runtime adapter owns Deno's native WebSocket upgrade and optional
HTTP listener boundary. It never creates or shuts down an injected Hypervisor.

Exports: `handler`, `serve`, and `DenoServeOptions`.

## Compose a handler

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.0-rc.1/hypervisor";
import { handler } from "jsr:@oxian/oxian-js@0.21.0-rc.1/adapters/deno";

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
import { serve } from "jsr:@oxian/oxian-js@0.21.0-rc.1/adapters/deno";

const listener = serve({ hypervisor, hostname: "0.0.0.0", port: 8080 });
await listener.finished;
```

`serve(options: DenoServeOptions)` returns a `HypervisorListener` with resolved
address, URL, `finished`, and idempotent `shutdown()`. An optional signal closes
only this listener.

Call `hypervisor.shutdown()` separately in the application layer that owns it.
