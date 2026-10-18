---
"oxianjs": minor
---

Add host-enabled worker-to-host invocation over the existing in-process and WebSocket
worker connection. Negotiate bounded reverse streams through reserved v1
handshake metadata; retain ordinary-only compatibility for peers that do not
acknowledge the extension.

Expose assignment-bound `WorkerWorkContext.callHost`, separately default-denied
`Worker.callHost`, host admission callbacks, streaming call handles, and
`HostCallError.execution` for not-started versus indeterminate outcomes.
Preserve independent capacity, session/parent fencing, cancellation, source
cleanup, drain, and reconnect limits without automatic replay. Durable owner
transactions, authorization, receipts, and recovery remain application-owned.
