# Durable owner retirement: migration evidence

Status: owner API retirement, 2026-10-16. This is an inventory of preserved
requirements and historical evidence, not a replacement implementation or a
claim that Copilotz owner conformance passes.

## Release and compatibility

This change prepares the 0.22.0 base for `0.22.0-next.<mergeSHA>` prereleases.
The successful main verification workflow publishes npm `next` and the matching
JSR version. It leaves npm `latest` at 0.21.3. No stable tag is part of this
release. See [the migration notes](migration-0.22.md) for the removed
entrypoints and retained transport boundary.

## Boundary

Oxian keeps its portable application/worker/Hypervisor, transports, dispatch,
session fencing, admission hooks and protocol. The unused generic owner,
owner-host and Postgres-owner API is removed. Durable command handling and
application storage belong in the concrete Copilotz runtime. The optional
[worker-to-host extension](worker-host-calls.md) now supplies generic reverse
transport and admission. It does not implement the concrete owner or certify the
replacement guarantees below. There is no retained test-only owner runtime or
placeholder owner API.

The Node listener's connection limiter remains, independently of ownership. It
can be shared across listeners, refuses overload, and releases leases on socket
closure. Its active tests live beside the adapter.

## Immutable recovery points

- Public main before retirement:
  `6cf55dc13834bafcfe9ef4c4067372b68982ae2f`
  ([source](https://github.com/AxionCompany/oxian-js/tree/6cf55dc13834bafcfe9ef4c4067372b68982ae2f))
- Preserved local owner-records work:
  `2dfebacf3408c0e25672289ec31e7201588d6cca`, on the separate recovery branch
  and in the transferred Git bundle. This commit is not a public release.
- Copilotz's unpushed parallel-kernel work and uncommitted wire changes remain
  in their original checkout. Their behavioral cases are reference material;
  the new runtime must use Copilotz's real tables, not adopt `owner_records`.

Use `git show <commit>:<path>` to recover an exact historical test. The retirement
branch starts at public main; it neither cherry-picks nor deletes the unpublished
owner-records commit. No existing database is modified by deleting these APIs.

## Test inventory

At the public-main recovery point, five files declare 46 cases:

| Historical path | Cases | Disposition |
|---|---:|---|
| `tests/owner/owner_test.ts` | 18 | Receipt/command cases for the concrete Copilotz owner |
| `tests/owner/sequence_test.ts` | 9 | Sequence/alarm cases for the real event log |
| `tests/owner/remote_test.ts` | 5 | Snapshot/recovery cases for authenticated worker calls |
| `tests/owner/postgres_test.ts` | 10 | Real-table transaction/fence cases |
| `tests/host/host_test.ts` | 4 | Two ownership cases remain migration work; two connection-budget cases rehomed |

`tests/owner/postgres_database.ts` was the test helper, not a conformance case.
Its Mac-specific local-cluster setup and the owner-only CI database service are
removed with the suites. The local owner-records commit adds three Postgres
cases, bringing its historical total to 49. Removing executable tests here
must not be reported as completion of their replacement coverage.

## Behavioral cases to port

The destination is tests next to Copilotz's concrete owner and storage code,
using existing domain/event tables. The F5/F7/F9 contracts and guarantee map
remain the acceptance bar. This checklist is evidence, not the whole plan.

| Guarantee | Historical tests or fixture | Replacement requirement |
|---|---|---|
| Result, effects and receipt are atomic | `owner_test.ts`: “a committed command returns its result and keeps its receipt” | One fenced outer transaction on real tables |
| Compatible replay, conflicting reuse, identity domains | “the same request returns its receipt; a different request is rejected”; “identity domains do not share receipts” | Stable logical intent, distinct incarnation/occurrence keys and separate current authority |
| Command-local rollback and timestamp | “one failing command rolls back only itself”; “a thrown command rolls back its writes and keeps the rest of the group”; “a lease crossed inside a group fails only the later command” | A savepoint and timestamp per command; no partial effects or publication |
| Unknown versus definitive commit outcome | “a lost commit stops the owner and the successor trusts receipts”; “a lost commit that aborted reruns each command once”; “a definitive rollback retries each command on its own” | Successor waits for server outcome; receipt recovery before preparing a different effect |
| Outer output gate | “post-commit callbacks run only after the commit is durable”; “a failed command does not run its post-commit callback” | Results, materialization, dispatch and notifications follow the outer commit |
| Admission and bounded queue | “admission admits 32 and recovers a receipt at capacity”; “a full queue refuses and a stopped owner reports ownership lost” | Atomic cap and bounded refusal; receipt recovery at capacity |
| Input/result isolation | “a command runs the input that was submitted”; “changing a returned receipt does not change the recorded one”; “commands in one group keep their own results” | Caller mutation cannot change accepted intent or recorded outcome |
| Epoch fencing | “a stale owner fails once a successor acquires the epoch”; Postgres takeover/open-transaction/assignment cases | Fence actual writes; takeover blocks behind unresolved transaction; routing alone is not authority |
| Mixed group uncertainty | `postgres_test.ts` lost-commit fixture mixes compatible duplicate, conflicting duplicate, success and failure, under committed/aborted outcomes | Keep this matrix and add actual in-flight COMMIT uncertainty |
| Failed transaction cleanup | Postgres failed-BEGIN/rollback case | Discard an unusable pooled connection |
| Receipt recovery without stale mutation | `remote_test.ts`: “an old session cannot mutate after takeover and can still read receipts” | Authenticated, owner-scoped same-worker recovery; no implicit protected-value hydration |
| Snapshot lifecycle | Remaining four `remote_test.ts` cases | Repeatable snapshot, cancellation, takeover, idle/lifetime expiry and in-flight failure; bounded sessions |
| Gap-free event sequence | `sequence_test.ts`: “a failed command and a duplicate consume no sequence”; “a rolled-back group consumes no sequence” | Existing `events.seq` shares effects/receipts/fence commit |
| Atomic attach and repair | “attach captures the head of its commit”; “a heartbeat head shows a dropped last update”; “a dropped push resets that observer” | Real push transport, reset and heartbeat-head repair |
| Durable alarms | Remaining four `sequence_test.ts` cases; Postgres alarm revision/sequence takeover cases | Wake after restart, early-timer guard, transient-read retry, rollback cleanup and actual scheduler semantics |
| Placement | `host_test.ts`: “a shard that does not own an id does not move its epoch”; “one process runs every owner assigned to it” | Named-owner routing and host-specific activation; no ownership claim from process count alone |
| Node overload protection | Former final two `host_test.ts` cases | Active `src/adapters/node/connection-budget.test.ts`; no owner-host dependency |

The three extra `2dfebac` cases assert that commit-after-rollback cannot persist
writes; committed records survive takeover while rolled-back writes do not;
and records are owner-isolated with bounded read-only snapshots. Preserve those
invariants against Copilotz tables. Generic map insertion order and the
`owner_records` schema are not requirements on domain storage.

## Limits of the old evidence

- Lost COMMIT responses were injected after completed commit/rollback. Killing
  an open transaction does not exercise an owner dying during COMMIT.
- Remote-session tests use local helpers, not authenticated worker RPC or the
  combined worker, connection, owner and execution-attempt fences.
- Observer tests manually acknowledge/reset; real dropped transport messages,
  subscriber authorization and end-to-end repair remain to prove.
- Alarm tests do not establish exact-due schedule claims, occurrence identity,
  misfire skipping, or paused/manual-run semantics.
- These files do not establish fresh stream allocation across attempts,
  protected-value grants, two-phase settlement, await/resume, effect
  reconciliation, full activation readiness, or saturated HTTP/Action progress.

These missing cases remain work. Retirement neither drops them nor marks them
passing. Durable Object activation/storage and production routing remain
host-specific work; deleting the old library does not implement either.

## Evidence that remains active in Oxian

All protocol, supervisor, transport, worker and Hypervisor suites remain.
In particular, `src/protocol/*.test.ts` and `tests/supervisor/*` retain the original
95 declared cases for byte/sequence credit, capacity reservation, cancellation,
drain, half-close, session generations, credential resume, durable acceptance and
committed-versus-indeterminate dispatch. The installed npm-package proof now
uses retained worker dispatch instead of the deleted owner/host API. The protocol
suites live beside their implementation with kebab-case names;
`src/protocol/host-calls.test.ts` adds 16 reverse-call cases.

No generic substring deletion of “owner” is appropriate: existing transport
resource ownership and admission responsibilities still have their own meaning.
