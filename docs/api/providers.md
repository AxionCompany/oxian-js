# Providers API

[← API reference](../api-reference.md)

The providers subpath defines Oxian's compute lifecycle boundary and three
implementations: Google Cloud Run Jobs, local child processes, and externally
managed computers.

```ts
import {
  createCloudRunJobsProvider,
  createExternallyAttachedProvider,
  createLocalProcessProvider,
  runProviderConformance,
  type WorkerProvider,
} from "jsr:@oxian/oxian-js@0.21.0-rc.3/providers";
```

A provider creates, observes, and terminates compute. It never authenticates
worker WebSockets, decides readiness, dispatches work, or owns a session.
`state: "present"` therefore means only that provider compute is observable.

## Exports

| Area                | Public exports                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract            | `ProviderResource`, `ProviderResourceState`, `ProviderInspection`, `ProviderTerminationOutcome`, `ProviderTermination`, `ProviderProvisionRequest`, `ProviderOperationOptions`, `ProviderTerminateOptions`, `WorkerProvider`, `ProviderErrorCode`, `ProviderError`                                           |
| Contract helpers    | `validateProviderId`, `validateProviderResourceId`, `cloneProviderJsonObject`, `createProviderError`, `isProviderError`, `throwIfProviderOperationAborted`, `createProviderResource`, `assertProviderOwnsResource`, `assertProviderResourceMatches`, `createProviderInspection`, `createProviderTermination` |
| Conformance         | `ProviderConformanceCheck`, `ProviderConformanceReport`, `ProviderConformanceOptions`, `runProviderConformance`                                                                                                                                                                                              |
| Externally attached | `ExternallyAttachedLaunchSpec`, `ExternallyAttachedProviderOptions`, `ExternallyAttachedResourceInput`, `ExternallyAttachedProvider`, `createExternallyAttachedProvider`                                                                                                                                     |
| Local process       | `LocalProcessStdio`, `LocalProcessLaunchSpec`, `LocalProcessHandle`, `LocalProcessSpawner`, `LocalProcessProviderOptions`, `createLocalProcessProvider`                                                                                                                                                      |
| Cloud Run Jobs      | `CloudRunJobsContainerOverride`, `CloudRunJobsLaunchSpec`, `CloudRunJobsProviderOptions`, `CloudRunJobsResourceInput`, `CloudRunJobsProvider`, `createCloudRunJobsProvider`                                                                                                                                  |

## Provider contract

### Lifecycle values

```ts
type ProviderResource = Readonly<{
  providerId: string;
  resourceId: string;
  identity: WorkerIdentity;
  createdAtMs: number;
  attributes: JsonObject;
}>;

type ProviderResourceState =
  | "present"
  | "absent"
  | "failed"
  | "unknown";

type ProviderInspection = Readonly<{
  resource: ProviderResource;
  state: ProviderResourceState;
  observedAtMs: number;
  details: JsonObject;
}>;

type ProviderTerminationOutcome =
  | "terminated"
  | "already_absent"
  | "unknown";

type ProviderTermination = Readonly<{
  resource: ProviderResource;
  outcome: ProviderTerminationOutcome;
  observedAtMs: number;
  details: JsonObject;
}>;
```

`ProviderResource` is the durable, fenced reference to compute for one worker
attempt. `attributes` may contain provider-neutral caller metadata and
implementation-owned names needed to inspect it again. Callers and provider
implementations must not put access tokens, connection IDs, readiness, socket
URLs, or workload state there. The generic constructor enforces safe JSON shape,
but it cannot infer whether an application-defined field is secret or session
state.

`details` is an observation, not durable identity. `"unknown"` explicitly
preserves ambiguity: callers must not interpret it as absence.

### `WorkerProvider`

```ts
type ProviderProvisionRequest<TLaunchSpec> = Readonly<{
  identity: WorkerIdentity;
  launch: TLaunchSpec;
}>;

type ProviderOperationOptions = Readonly<{
  signal?: AbortSignal;
}>;

type ProviderTerminateOptions = Readonly<{
  signal?: AbortSignal;
  gracePeriodMs?: number;
}>;

type WorkerProvider<TLaunchSpec> = Readonly<{
  providerId: string;
  provision(
    request: ProviderProvisionRequest<TLaunchSpec>,
    options?: ProviderOperationOptions,
  ): Promise<ProviderResource>;
  inspect(
    resource: ProviderResource,
    options?: ProviderOperationOptions,
  ): Promise<ProviderInspection>;
  terminate(
    resource: ProviderResource,
    options?: ProviderTerminateOptions,
  ): Promise<ProviderTermination>;
}>;
```

Providers must honor a pre-aborted `signal` without mutating state. The
`gracePeriodMs` field is a best-effort hint: an implementation whose API only
supports immediate cancellation may validate and ignore it. Termination is
idempotent for a known resource: the first confirmed transition reports
`"terminated"` and later calls report `"already_absent"`.

### Contract constructors and validators

```ts
function validateProviderId(providerId: string): string;
function validateProviderResourceId(resourceId: string): string;

function cloneProviderJsonObject(
  value: unknown,
  path?: string, // default: "$"
): JsonObject;

function createProviderResource(input: {
  providerId: string;
  resourceId: string;
  identity: WorkerIdentity;
  createdAtMs: number;
  attributes?: JsonObject;
}): ProviderResource;

function createProviderInspection(input: {
  resource: ProviderResource;
  state: ProviderResourceState;
  observedAtMs: number;
  details?: JsonObject;
}): ProviderInspection;

function createProviderTermination(input: {
  resource: ProviderResource;
  outcome: ProviderTerminationOutcome;
  observedAtMs: number;
  details?: JsonObject;
}): ProviderTermination;
```

These helpers validate, recursively copy, and freeze the returned value.
Provider IDs are at most 128 characters, start alphanumerically, and then allow
alphanumerics, `.`, `_`, `:`, or `-`. Resource IDs are non-empty, at most 512
characters, and contain no ASCII control characters. Timestamps are non-negative
safe integers.

`cloneProviderJsonObject` accepts only plain JSON objects containing finite
numbers, enumerable data properties, no symbol keys, no cycles, no array extras,
and no more than 32 nesting levels. `path` customizes validation error
locations.

```ts
function assertProviderOwnsResource(
  providerId: string,
  resource: ProviderResource,
): ProviderResource;

function assertProviderResourceMatches(
  providerId: string,
  suppliedResource: ProviderResource,
  storedResource: ProviderResource,
): ProviderResource;
```

`assertProviderOwnsResource` validates and copies the supplied reference, then
rejects a different owner with `code: "invalid_resource"`.
`assertProviderResourceMatches` additionally compares provider ID, resource ID,
creation time, complete worker identity, and structural JSON attributes with a
known stored reference. It returns the original `storedResource` on success.

### Provider errors and cancellation

```ts
type ProviderErrorCode =
  | "aborted"
  | "conflict"
  | "invalid_launch_spec"
  | "invalid_resource"
  | "inspection_failed"
  | "provision_failed"
  | "provision_indeterminate"
  | "termination_failed";

type ProviderError =
  & Error
  & Readonly<{
    name: "ProviderError";
    code: ProviderErrorCode;
    providerId: string;
    resourceId?: string;
  }>;

function createProviderError(input: {
  code: ProviderErrorCode;
  message: string;
  providerId: string;
  resourceId?: string;
  cause?: unknown;
}): ProviderError;

function isProviderError(value: unknown): value is ProviderError;

function throwIfProviderOperationAborted(
  signal: AbortSignal | undefined,
): void;
```

`createProviderError` preserves `cause` and adds enumerable `code`,
`providerId`, and, when present, `resourceId`. `isProviderError` is a structural
guard over an `Error`; it does not revalidate every code or ID. The abort helper
uses `AbortSignal.throwIfAborted()`, preserving the signal's native reason.
Built-in providers normally surface native `AbortError` for cancellation rather
than wrapping it as a `ProviderError`.

## Conformance harness

```ts
type ProviderConformanceCheck =
  | "pre-aborted provision"
  | "provision"
  | "resource identity"
  | "session-independent resource"
  | "inspect present"
  | "pre-aborted inspect"
  | "pre-aborted terminate"
  | "terminate"
  | "inspect absent"
  | "idempotent terminate";

type ProviderConformanceOptions<TLaunchSpec> = Readonly<{
  provider: WorkerProvider<TLaunchSpec>;
  launch: TLaunchSpec;
  identity?: WorkerIdentity;
}>;

type ProviderConformanceReport = Readonly<{
  checks: readonly ProviderConformanceCheck[];
  resource: ProviderResource;
  initialInspection: ProviderInspection;
  termination: ProviderTermination;
  finalInspection: ProviderInspection;
  repeatedTermination: ProviderTermination;
}>;

function runProviderConformance<TLaunchSpec>(
  options: ProviderConformanceOptions<TLaunchSpec>,
): Promise<ProviderConformanceReport>;
```

The runner is test-framework independent. It verifies pre-abort behavior, fenced
identity preservation, absence of the top-level fields `connectionId`, `ready`,
`session`, `socket`, `target`, and `url`, initial presence, confirmed and
idempotent termination, and final absence. It does not inspect
application-defined nested attributes for semantic secrets or session state. It
attempts cleanup if a later check fails. A failed assertion throws an `Error`
prefixed with `WorkerProvider conformance failed:`.

## Externally attached provider

Use this provider for a laptop, workstation, or other machine whose compute
lifecycle is controlled outside Oxian. Provisioning records a logical
reservation; it does not launch the machine or claim it is online.

```ts
type ExternallyAttachedLaunchSpec = Readonly<{
  attachmentId: string;
  attributes?: JsonObject;
}>;

type ExternallyAttachedProviderOptions = Readonly<{
  providerId?: string; // default: "externally-attached"
  now?: () => number; // default: Date.now
  createResourceId?: (
    request: Readonly<{
      attachmentId: string;
      workerId: string;
      attemptId: string;
      epoch: number;
    }>,
  ) => string; // default: crypto.randomUUID
}>;

type ExternallyAttachedResourceInput = Readonly<{
  resourceId: string;
  identity: WorkerIdentity;
  attachmentId: string;
  createdAtMs: number;
  attributes?: JsonObject;
}>;

type ExternallyAttachedProvider =
  & WorkerProvider<ExternallyAttachedLaunchSpec>
  & Readonly<{
    rehydrateResource(
      input: ExternallyAttachedResourceInput,
    ): ProviderResource;
  }>;

function createExternallyAttachedProvider(
  options?: ExternallyAttachedProviderOptions,
): ExternallyAttachedProvider;
```

The provider adds the canonical `attachmentId` to resource attributes. A
caller-supplied conflicting value fails as `"invalid_resource"`. A generated
resource-ID collision fails as `"conflict"`.

An unknown reference inspects as `"unknown"` and terminates as `"unknown"`;
Oxian does not invent absence. A known active reservation is `"present"`.
Termination changes only this logical reservation and is idempotent.

`rehydrateResource` restores provider identity from application-owned durable
fields after a restart. Repeating the exact restore returns the existing
resource. A conflicting fenced reference is rejected, and a resource already
terminated in this provider instance is never revived. Connection and readiness
still come exclusively from an authenticated session.

## Local process provider

### Launch and injection types

```ts
type LocalProcessStdio = "inherit" | "null";

type LocalProcessLaunchSpec = Readonly<{
  command: string | URL;
  args?: readonly string[];
  cwd?: string | URL;
  env?: Readonly<Record<string, string>>;
  clearEnv?: boolean; // default: true
  stdin?: LocalProcessStdio; // default: "null"
  stdout?: LocalProcessStdio; // default: "inherit"
  stderr?: LocalProcessStdio; // default: "inherit"
  attributes?: JsonObject;
}>;

type LocalProcessHandle = Readonly<{
  pid: number;
  status: Promise<Deno.CommandStatus>;
  kill(signal?: Deno.Signal): void;
}>;

type LocalProcessSpawner = (
  command: string | URL,
  options: Deno.CommandOptions,
) => LocalProcessHandle;

type LocalProcessProviderOptions = Readonly<{
  providerId?: string; // default: "local-process"
  now?: () => number; // default: Date.now
  createResourceId?: (
    request: Readonly<{
      workerId: string;
      attemptId: string;
      epoch: number;
    }>,
  ) => string; // default: crypto.randomUUID
  defaultGracePeriodMs?: number; // default: 5_000
  forceExitTimeoutMs?: number; // default: 5_000
  gracefulSignal?: Deno.Signal; // default: "SIGTERM"
  forceSignal?: Deno.Signal; // default: "SIGKILL"
  spawnProcess?: LocalProcessSpawner;
}>;

function createLocalProcessProvider(
  options?: LocalProcessProviderOptions,
): WorkerProvider<LocalProcessLaunchSpec>;
```

The default spawner invokes `new Deno.Command(command, options).spawn()`
directly; a shell never parses the command or arguments. Environment inheritance
is disabled by default so parent credentials do not leak into workers. The
implementation requires a non-empty string or `URL` command, string arguments
without null characters, a non-empty string or `URL` working directory when
present, supported stdio values, a boolean `clearEnv`, non-empty environment
names without `=` or null characters, and string environment values without null
characters. The launch object is not an exact-key or plain-object boundary, and
`args` may be any iterable that yields valid strings. Invalid checked values
throw `ProviderError` with `code: "invalid_launch_spec"`.

The durable resource contains the command label and caller attributes, but not
environment variables or arguments. A live child inspects as `"present"`. After
natural exit, successful or provider-requested exit is `"absent"` and an
unexpected unsuccessful exit is `"failed"`. An unrecognized reference is
`"unknown"`.

Termination sends the graceful signal, waits `gracePeriodMs`, sends the force
signal if necessary, then waits `forceExitTimeoutMs`. Both durations accept zero
and must be non-negative safe integers. Concurrent callers share one termination
task. Aborting a caller's wait does not abandon the child; cleanup continues in
the provider closure. An unobservable status or process that survives the force
timeout fails with `"termination_failed"`.

## Google Cloud Run Jobs provider

### Options and launch specification

```ts
type CloudRunJobsContainerOverride = Readonly<{
  name?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}>;

type CloudRunJobsLaunchSpec = Readonly<{
  job: string;
  containerOverride?: CloudRunJobsContainerOverride;
  timeoutSeconds?: number;
  attributes?: JsonObject;
}>;

type CloudRunJobsProviderOptions = Readonly<{
  project: string;
  location: string;
  getAccessToken(
    options?: ProviderOperationOptions,
  ): string | Promise<string>;
  providerId?: string; // default: "google-cloud-run-jobs"
  fetcher?: typeof fetch;
  now?: () => number; // default: Date.now
}>;

type CloudRunJobsResourceInput = Readonly<{
  identity: WorkerIdentity;
  createdAtMs: number;
  job: string;
  operationName: string;
  executionName?: string;
  attributes?: JsonObject;
}>;

type CloudRunJobsProvider =
  & WorkerProvider<CloudRunJobsLaunchSpec>
  & Readonly<{
    rehydrateResource(
      input: CloudRunJobsResourceInput,
    ): ProviderResource;
  }>;

function createCloudRunJobsProvider(
  options: CloudRunJobsProviderOptions,
): CloudRunJobsProvider;
```

`project` is a bounded Google Cloud project ID or number and `location` is a
lowercase resource segment. `job` is the short Job ID in that scope, not a full
resource name. The provider always sends an override with `taskCount: 1`.

Container override rules:

- `name`, when present, is a DNS label.
- `args` contains at most 1,000 strings, each at most 32,768 characters and
  without nulls. An empty array emits Cloud Run's `clearArgs`.
- `env` is a plain record with at most 1,000 conventional environment names;
  values are strings at most 32,768 characters without nulls.
- `timeoutSeconds` is an integer from 1 through 604,800.
- Unknown properties, accessors, symbol keys, and malformed JSON attributes fail
  before token acquisition or network I/O with `"invalid_launch_spec"`.

`getAccessToken` is called for each lifecycle operation and receives that
operation's abort signal. A token must be a non-empty bounded printable ASCII
string. Tokens, request URLs, container overrides, and session state are never
persisted in `ProviderResource`.

### Cloud Run lifecycle semantics

`provision` calls the Cloud Run v2 Job `:run` endpoint exactly once. The
resource ID is the canonical long-running operation name; canonical Job,
operation, and, when known, execution names are stored as private provider
attributes alongside caller attributes. Conflict responses use `"conflict"`.
Transport failures, redirects, timeout-class responses, server responses, or an
accepted but unreadable operation use `"provision_indeterminate"` when Oxian
cannot prove whether compute was created.

`inspect` reads the operation and, once known, its execution. It reports:

- `"present"` while provisioning or running;
- `"absent"` when cancelled, completed, deleted, or no longer found after a
  resolved operation;
- `"failed"` for a failed operation or execution;
- `"unknown"` when the operation is absent before any execution can be
  identified.

Inconsistent names, task counts other than the forced single task, malformed
Google responses, and non-success API reads fail with `"inspection_failed"`.
Response bodies are bounded to 1 MiB.

`terminate` validates but otherwise ignores `gracePeriodMs`, because Cloud Run
Jobs exposes cancellation rather than a separate graceful signal. It first
resolves the exact execution, issues one `:cancel`, then performs one
confirmation read. It returns `"terminated"` only if that read proves terminal
state, `"already_absent"` for an already terminal or missing execution, and
`"unknown"` when provisioning or cancellation outcome remains ambiguous. It
never polls or replays a mutation automatically.

`rehydrateResource` reconstructs the provider-owned canonical attributes from a
durable neutral record. Job, operation, and execution names must remain in the
factory's configured project/location scope. Caller attributes cannot override
those provider attributes. The provider is otherwise stateless, so persisted
resources can be inspected by a newly created provider instance.
