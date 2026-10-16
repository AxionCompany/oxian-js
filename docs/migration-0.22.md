# Migrating to the 0.22 prerelease

The 0.22.0 source base introduces a breaking removal of unused owner APIs.
Successful verification on `main` publishes `0.22.0-next.<mergeSHA>` to npm's
`next` tag and mirrors the exact same version to JSR. This is a prerelease:
`latest` stays at 0.21.3, and no `v0.22.0` stable tag is created by this work.

Use `npm install oxianjs@next` to try the new Node package. For a reproducible
installation, pin the exact returned version. JSR users should likewise select
the matching published next version rather than assume a stable 0.22.0 exists.
Current source API examples use the base version; substitute that next version
when installing from the registry.

## Removed APIs

The `/owner`, `/host`, and `/adapters/postgres` package entrypoints no longer
exist. This removes `createOwner`, `createMemoryOwnerStore`, command/snapshot
sessions, `createOwnerHost`, shard maps and the Postgres-owner store. The
standalone implementation was unused by applications. It is not retained behind
aliases or compatibility stubs, and importing those entrypoints now fails.

A downstream experiment that still uses these APIs must remain pinned to its
previous version or preserved checkout until its concrete replacement is ready.
The full Git history and the behavioral migration inventory remain available;
see [retirement evidence](owner-retirement.md). No database data is deleted or
migrated by upgrading the package.

Copilotz will own its durable command and storage runtime. That replacement,
authenticated reverse calls, real-table group commits, recovery and deployment
integration are not implemented by this release. Removing the library does not
certify those guarantees or add worker-to-owner invocation to the protocol.

## Retained Node surface

The npm build now exposes:

- `oxianjs`: the portable application, HTTP, Hypervisor, worker and work core
- `/adapters/node`: the Node HTTP/WebSocket listener and connection budget
- `/http`, `/hypervisor`, `/protocol`, `/transport`, `/work`, `/worker`
- `/providers`: the portable provider contract, externally attached provider,
  Cloud Run Jobs provider and conformance helpers

Node 24 or newer is required. `ws` is the Node listener's runtime dependency;
Postgres and its type dependency have been removed. Importing the portable root
still does not create listeners, spawn processes or require a database.

The npm `/providers` subpath excludes the Deno local-process provider. The
Deno-bound `/app`, `/config`, `/local`, `/router`, `/edge`, `/cli`, `/bin`, and
`/adapters/deno` remain available only in the retained JSR surface during the
Node migration. The npm build is deliberately not advertised as full JSR parity.

## Node listener migration

`serve({ hypervisor })` still defaults to a 1,000-connection budget. To share a
lower limit between listeners, import `createConnectionBudget` from
`oxianjs/adapters/node` and pass the same value as each listener's `budget`.
This replaces the old owner-host object for that purpose. Budget acquisition
refuses excess upgrades with HTTP 503; socket closure releases the lease once,
including for rejected upgrades. Closing a listener does not close an injected
budget or the application-owned Hypervisor.

## Verification

The release retains Oxian's protocol, supervisor, transport, worker and
Hypervisor suites. CI checks Node and Deno plus an installed npm tarball:
public exports, missing retired subpaths, declaration consumption, absence of
tests/raw TypeScript in the npm payload, and real in-process and Node WebSocket
work dispatch. Historical owner tests remain migration evidence, not executable
replacement coverage. Stable publication still requires its separate exact-tag
workflow and is outside this prerelease.
