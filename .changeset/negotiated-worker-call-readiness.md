---
"oxianjs": patch
---

Expose immutable, protocol-validated worker-call capability agreement on the
Hypervisor Ready context. Hosts can reject missing support in the existing
awaited readiness callback before routability and ReadyAck, without trusting
application metadata or changing ordinary-only worker behavior.
