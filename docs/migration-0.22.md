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

Copilotz owns its durable command and storage runtime. The optional
[worker-to-host extension](worker-host-calls.md) now supplies generic
authenticated reverse streams and admission on the existing connection. It does
not implement or certify concrete owner transactions, real-table group commits,
receipts, recovery, or deployment integration.

## Optional host calls

Existing Workers remain ordinary-only unless both peers opt in. Configure
`HypervisorOptions.workerCalls` and `WorkerOptions.hostCalls` to enable
`WorkerWorkContext.callHost`. Parentless `Worker.callHost` requires the separate
`admitUnassigned` policy and is denied by default. Applications implementing
`WorkerWorkContext` or `Worker` test doubles must now provide `callHost`; it may
reject with `createHostCallError("unsupported", "not_started")` when
unavailable.

Do not place `__oxian_worker_calls_v1` in application bootstrap or Ready
metadata; it is reserved for negotiation. The wire protocol stays
`oxian.worker.v1`, and an old peer without acknowledgement retains ordinary work
behavior. There is no automatic replay after a host call becomes indeterminate;
recovery belongs to the application.

## Retained Node surface

The npm build now exposes:

- `oxianjs`: the portable application, HTTP, Hypervisor, worker and work core
- `/adapters/node`: the Node HTTP/WebSocket listener and connection budget
- `/http`, `/hypervisor`, `/protocol`, `/transport`, `/work`, `/worker`
- `/router`: existing file-router discovery, validation and pathname matching
- `/config`: existing configuration validation and local TypeScript module loading
- `/app`: existing application, factory loading and configured-application composition
- `/providers`: the portable provider contract, externally attached provider,
  Cloud Run Jobs provider and conformance helpers

Node 24 or newer is required. `ws` is the Node listener's runtime dependency;
Postgres and its type dependency have been removed. Importing the portable root
still does not create listeners, spawn processes or require a database.

The npm `/providers` subpath excludes the Deno local-process provider. The
Deno-bound `/local`, `/edge`, `/cli`, `/bin`, and
`/adapters/deno` remain available only in the retained JSR surface during the
Node migration. The npm build is deliberately not advertised as full JSR parity.

## Configuration and application factories

The existing `defineConfig`, `loadConfig`, `defineApplicationFactory`,
`loadApplicationFactory` and `createConfiguredApplication` signatures and
validation remain the same. Their filesystem paths use an internal Node adapter
that also works in Deno. Config-relative route, static-root and factory paths
still resolve against the config module directory, without changing the
process working directory.

Loaders still accept only local `.ts` modules. Config modules must export exactly
one data value (`default` or `config`); factory modules must export exactly one
default function. Use erasable TypeScript syntax and keep application-authored
modules outside `node_modules` for Node's built-in type stripping. Use ESM
imports and a containing `package.json` with `"type": "module"`. No transpiler,
import map or implicit environment expansion is installed by these loaders.

```ts
import { loadConfig } from "oxianjs/config";
import { createConfiguredApplication } from "oxianjs/app";

const config = await loadConfig("./oxian.config.ts");
const { application } = await createConfiguredApplication({
  config: config.application,
  signal: new AbortController().signal,
});
const response = await application.fetch(new Request("https://example.test/"));
await response.text();
await application.dispose();
```

These host-backed subpaths are explicit imports. They do not add filesystem
loading to the portable root or start a local runtime/listener.

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
Hypervisor suites. CI checks Node and Deno plus an installed npm tarball: public
exports, missing retired subpaths, declaration consumption, absence of tests/raw
TypeScript in the npm payload, real file-route and middleware execution,
config/factory imports and default/configured application execution, and real in-process and Node WebSocket work dispatch. Historical owner tests remain migration evidence, not executable
replacement coverage. Stable publication still requires its separate exact-tag
workflow and is outside this prerelease.


The config/application parity slice retains all 33 existing cases, colocated as
`src/config/config.test.ts` (10), `src/config/loader.test.ts` (7),
`src/app/factory.test.ts` (3) and `src/app/application.test.ts` (13). Four added
Node adapter regressions cover path/URL loading, default composition and router
cancellation, rejected module sources, and cleanup when a factory loses a
cancellation race. All 37 run in Node and Deno; they replace no historical
behavioral cases.
