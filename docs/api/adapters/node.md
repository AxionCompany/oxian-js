# `jsr:@oxian/oxian-js@0.22.0/adapters/node`

This explicit runtime adapter owns a Node `node:http` listener and its WebSocket
upgrades (through `ws`). It never creates or shuts down an injected Hypervisor.

Exports: `serve`, `NodeServeOptions`, `CONNECTION_BUDGET`,
`createConnectionBudget`, `ConnectionBudget`, and `ConnectionLease`.

## Own a listener

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.22.0/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.22.0/adapters/node";

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
from `budget`. When omitted, the listener creates its own budget of 1,000
connections and answers 503 past it. Pass the same `createConnectionBudget(limit)`
to several listeners to share a process-wide cap. Limits are integers from 1 to
`CONNECTION_BUDGET` (1,000). A lease is released once when its socket closes,
including rejected upgrades. `snapshot()` reports active connections and the
limit; `close()` refuses new leases without closing existing sockets. A listener
never closes an injected budget. This limiter has no owner, storage or shard
responsibilities. An optional signal closes only this listener.

Call `hypervisor.shutdown()` separately in the application layer that owns it.
