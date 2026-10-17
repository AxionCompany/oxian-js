# oxianjs

## Unreleased

### Added

- Opt-in worker-to-host calls over existing in-process and WebSocket
  connections, with v1 capability negotiation, assignment-bound host admission,
  separately default-denied parentless routes, and streaming call handles.
- Independent reverse-call capacity, deadline and session/parent checks, drain
  support, and source-cleanup reservations across reconnect. Calls are never
  automatically replayed; ambiguous outcomes require application receipt
  recovery. See [worker-to-host calls](docs/worker-host-calls.md).

This addition supplies generic transport and admission, not the concrete
Copilotz durable owner runtime. No version or release is created by this entry.

## 0.22.0

### Minor Changes

- Prepare the 0.22 prerelease line with a breaking removal of the unused generic
  owner, owner-host and Postgres-owner APIs. Durable ownership moves to the
  concrete Copilotz runtime, whose replacement implementation remains pending.

  Retain worker dispatch, transports, sessions and independent Node connection
  budgeting. Publish the existing Node-portable root and explicit subpaths, with
  installed-package type and in-process/WebSocket proofs; remove the owner-only
  PostgreSQL dependency and CI service.

  This base version is used for merge-triggered `0.22.0-next.<mergeSHA>` builds
  on npm's `next` tag and the same-version JSR mirror. It does not authorize a
  stable `v0.22.0` tag or move npm's `latest` tag. See the migration and
  retirement documentation for removed APIs, supported exports and preserved
  conformance evidence.
