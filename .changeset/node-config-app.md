---
"oxianjs": minor
---

Expose the existing configuration and application-factory APIs at `oxianjs/config`
and `oxianjs/app` in the Node package. Keep signatures, validation and local
TypeScript-module loading unchanged, using internal Node path/URL adapters while
retaining Deno compatibility and the portable root.
