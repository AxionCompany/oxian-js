---
"oxianjs": patch
---

Preserve Node listener Response metadata across HTTP fallback and rejected
WebSocket upgrades, including custom status text, authentication/retry headers,
and repeated cookies. Validate rejection headers before writing and keep
connection/body framing transport-owned.
