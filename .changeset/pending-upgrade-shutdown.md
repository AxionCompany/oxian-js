---
"oxianjs": patch
---

Close pending HTTP Upgrade sockets during Node listener shutdown, including
requests waiting on an application fallback or its response body. Release the
shared connection lease on socket close and prevent late response writes.
