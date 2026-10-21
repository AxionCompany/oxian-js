# `jsr:@oxian/oxian-js@0.23.0/adapters/node`

This explicit runtime adapter owns a Node `node:http` listener and its WebSocket
upgrades (through `ws`). It never creates or shuts down an injected Hypervisor.

Exports: `serve`, `NodeServeOptions`, `CONNECTION_BUDGET`,
`createConnectionBudget`, `ConnectionBudget`, and `ConnectionLease`.

## Own a listener

```ts
import { createHypervisor } from "jsr:@oxian/oxian-js@0.23.0/hypervisor";
import { serve } from "jsr:@oxian/oxian-js@0.23.0/adapters/node";

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

`shutdown()` closes accepted WebSockets and pending Upgrade sockets, including
those waiting on an application fallback or response body, and waits for their
connection leases to be released. A late fallback response cannot write to the
closed socket. This closes transport resources; it cannot force an arbitrary
application promise or an already-running response-body producer to settle.
Applications still own cancellation and bounds for that work.

Ordinary fallback requests receive a `Request.signal` that aborts on an
incomplete incoming body, a premature response close, or listener shutdown.
Normal request-body completion does not abort an ongoing response. Each
keep-alive request has its own lifetime; a later disconnect cannot cancel an
already-finished request. Pending Upgrade fallbacks instead follow their Upgrade
socket lifetime. The existing HTTP gateway forwards this cancellation to work;
applications must still observe the signal and bound noncooperative work.

Call `hypervisor.shutdown()` separately in the application layer that owns it.
