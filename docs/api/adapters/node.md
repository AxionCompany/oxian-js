# `jsr:@oxian/oxian-js@0.21.3/adapters/node`

This explicit runtime adapter owns a Node `node:http` listener and its WebSocket
upgrades (through `ws`). It never creates or shuts down an injected Hypervisor.

Exports: `serve` and `NodeServeOptions`.

## Own a listener

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.21.3/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.21.3/adapters/node";

const hypervisor = createHypervisor({
  transports: [{
    type: "websocket",
    config: { path: "/_oxian/workers/connect" },
  }],
  admit,
});

const listener = await serve({ hypervisor, hostname: "0.0.0.0", port: 8080 });
await listener.finished;
```

`serve(options: NodeServeOptions)` resolves once the listener is bound, to a
`HypervisorListener` with resolved address, URL, `finished`, and idempotent
`shutdown()`. Each upgrade calls `hypervisor.prepare()`, accepts only the
subprotocol the Hypervisor selected, adapts the socket, and attaches it once.
Other requests use the Hypervisor fallback. Each upgrade takes one connection
from `budget`. When `budget` is omitted the listener uses the host cap of
1,000 and answers 503 past it. An optional signal closes only this listener.

Call `hypervisor.shutdown()` separately in the application layer that owns it.
