---
"oxianjs": patch
---

Reject stale asynchronous assign selections when dispatch waiting is disabled.
An exact selected session can no longer silently route work to a replacement
connection for the same logical worker. Queued selection retry and explicit
logical-worker targeting retain their existing behavior.
