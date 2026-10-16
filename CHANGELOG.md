# oxianjs

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
