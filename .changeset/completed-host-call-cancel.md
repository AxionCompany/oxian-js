---
"oxianjs": patch
---

Make cancellation of a fully completed reverse call harmless. Late handle or
unread-output cancellation no longer emits a post-terminal frame that could
close the shared connection and interrupt parent or sibling work. Preserve
one-sided half-close cancellation and deferred source cleanup.
