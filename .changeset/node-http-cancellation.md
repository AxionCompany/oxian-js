---
"oxianjs": patch
---

Propagate premature Node HTTP disconnects through Request.signal, including
unfinished request bodies, responses and Upgrade fallbacks. Preserve normal
body completion and keep-alive request isolation so the existing HTTP gateway
can cancel assigned work and release execution capacity.
