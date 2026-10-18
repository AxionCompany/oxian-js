---
"oxianjs": patch
---

Automatically acknowledge the versioned worker-to-host capability when offered;
retain worker capacity/timeout configuration and explicit host admission policy.
Missing negotiation disables reverse calls with no fallback.

Negotiate and partition connection lifetime slots between both initiators,
reserve queued Opens, and rotate when either share is spent without invalid
Opens or loss of the active parent. Enforce negotiated capacity for unsettled
host reservations. Preserve recognized remote error codes and conservative
execution ambiguity.

Bound aggregate request and response bodies at the host (16 MiB each by default,
configurable with maxRequestBytes/maxResponseBytes), reporting payload_too_large.
Document application-owned open/use/close handles, expiry, cancellation,
termination, disconnect/takeover cleanup, and transactional owner fencing.
