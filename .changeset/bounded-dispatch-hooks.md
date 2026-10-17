---
"oxianjs": patch
---

Bound assign and onWorkAssigned callbacks with one shared entry-to-Open deadline
in both dispatch queue modes. The existing dispatchQueueTimeoutMs now includes
these hooks; it still does not limit execution after Open. Add a separate
maxPendingDispatchHooks budget and pendingDispatchHooks snapshot count.

Caller cancellation, timeout, drain and session replacement refuse promptly,
while noncooperative hooks retain their occupancy until actual settlement.
Assigned-but-unopened work retains its reservation until callback settlement or
session loss and cannot open late. Preserve ordinary worker/queue and reverse
call capacity independently.
