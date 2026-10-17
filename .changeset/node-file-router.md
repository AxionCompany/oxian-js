---
"oxianjs": minor
---

Expose the existing file-router API at `oxianjs/router` in the Node package.
Use Node filesystem, path and URL APIs through an internal adapter, retaining
Deno compatibility, deterministic discovery, symlink exclusion, startup
validation and synchronous pathname matching. Keep the package root portable.
