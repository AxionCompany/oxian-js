# Local runtime API

[← API reference](../api-reference.md)

The local subpath contains two compositions:

- `createLocalRuntime` runs an application, Hypervisor, and outbound worker in
  one process for `oxian start` and `oxian dev`.
- `createManifestWorkerRuntime` runs an application as a standalone outbound
  WebSocket worker described by a strict local manifest.

It also exposes manifest loading, durable resume-credential storage, and edge
composition.

```ts
import {
  createLocalRuntime,
  createManifestWorkerRuntime,
  loadWorkerManifest,
} from "jsr:@oxian/oxian-js@0.20.0-rc.3/local";
```

Constructing either runtime is side-effect free. `start()` owns imports,
filesystem access, sockets, and listeners. Neither runtime installs signal
handlers or exits the process.

## Exports

| Area                   | Public exports                                                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single-process runtime | `LocalRuntimeMode`, `LocalRuntimeState`, `LocalRuntimeOptions`, `LocalRuntimeSnapshot`, `LocalRuntimeRunning`, `LocalRuntime`, `createLocalRuntime` |
| Worker manifest        | `DurableCredentialStore`, `EphemeralCredentialStore`, `WorkerCredentialStore`, `WorkerManifest`, `LoadWorkerManifestSource`, `loadWorkerManifest`   |
| Resume store           | `WorkerResumeCredentialState`, `AtomicResumeCredentialStore`, `createAtomicResumeCredentialStore`                                                   |
| Manifest worker        | `ManifestWorkerRuntimeOptions`, `ManifestWorkerRuntimeRunning`, `ManifestWorkerRuntime`, `createManifestWorkerRuntime`                              |
| Edge composition       | `composeConfiguredEdge`                                                                                                                             |

## Single-process local runtime

### Types

```ts
type LocalRuntimeMode = "start" | "dev";

type LocalRuntimeState =
  | "idle"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

type LocalRuntimeOptions = Readonly<{
  config: OxianConfig;
  mode?: LocalRuntimeMode; // default: "start"
  listener?: Readonly<{
    hostname?: string;
    port?: number;
  }>;
  workerId?: string; // default: "oxian-local-http"
  capacity?: number; // default: 1
}>;

type LocalRuntimeSnapshot = Readonly<{
  state: LocalRuntimeState;
  listenerUrl?: string;
  workerUrl?: string;
  identity?: WorkerIdentity;
}>;

type LocalRuntimeRunning = Readonly<{
  listenerUrl: URL;
  workerUrl: URL;
  identity: WorkerIdentity;
  router: FileRouter<unknown>;
  application: Application<unknown>;
  hypervisor: Hypervisor;
  worker: WorkerClient;
}>;

type LocalRuntime = Readonly<{
  start(): Promise<LocalRuntimeRunning>;
  stop(reason?: string): Promise<void>;
  readonly finished: Promise<void>;
  snapshot(): LocalRuntimeSnapshot;
}>;
```

`listener.hostname` and `listener.port` override the corresponding configuration
for this run. Port `0` requests an ephemeral operating-system port; valid ports
are integers from 0 through 65,535. `workerId` is validated as a supervisor
identifier and `capacity` as a positive safe integer during startup.

### `createLocalRuntime`

```ts
function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntime;
```

On `start()`, the runtime:

1. compiles the configured router and creates the configured application;
2. wraps it as the built-in HTTP workload;
3. creates one in-memory worker repository and registration authority;
4. creates a Hypervisor whose acceptance hook resolves immediately;
5. binds its HTTP/WebSocket listener;
6. connects one ephemeral-credential worker back to that listener; and
7. resolves only after the worker is ready.

This is an honest WebSocket topology, useful for local execution and end-to-end
testing, but its repository, credential authority, and acceptance decision are
not durable. Production durability remains an application concern.

`mode: "dev"` enables a configured development proxy. Both modes apply
configured CORS and static-file edges. `workerUrl` is derived from the actual
bound listener and the Hypervisor worker path, using `ws:` for HTTP and `wss:`
for HTTPS.

Repeated `start()` calls return the same promise. `stop(reason)` is idempotent,
may preempt an in-progress startup, shuts down the Hypervisor, listener, worker,
and application, and prevents restart. Its default reason is
`"local_runtime_stopped"`. `finished` resolves after an orderly stop and rejects
on a runtime failure. An unexpected worker result creates an error named
`LocalRuntimeWorkerError`. `snapshot()` is a frozen point-in-time value; URLs
and identity appear only after startup completes.

## Edge composition

```ts
function composeConfiguredEdge(
  handler: FetchHandler,
  edge: EdgeConfig | undefined,
  mode: LocalRuntimeMode,
): FetchHandler;
```

The function composes declarative edge adapters without changing the application
or worker protocol. In incoming request order the wrappers are:

1. CORS, when configured;
2. static files, when configured;
3. development proxy, only in `mode: "dev"`; then
4. the supplied handler.

Adapter defaults and validation are defined by the `/edge` and `/config`
subpaths. The returned handler is frozen.

## Worker manifest

### Manifest types

```ts
type DurableCredentialStore = Readonly<{
  mode: "durable";
  path: string;
}>;

type EphemeralCredentialStore = Readonly<{
  mode: "ephemeral";
}>;

type WorkerCredentialStore =
  | DurableCredentialStore
  | EphemeralCredentialStore;

type WorkerManifest = Readonly<{
  gatewayUrl: string;
  identity: WorkerIdentity;
  credential: WorkerCredential;
  handshakeId: string;
  resumeExpiresAtMs?: number;
  capacity: number;
  applicationConfig: string;
  credentialStore: WorkerCredentialStore;
}>;

type LoadWorkerManifestSource = string | URL;
```

A manifest module has this shape:

```ts
export default {
  gatewayUrl: "wss://control.example/_oxian/workers/connect",
  identity: {
    workerId: "laptop-1",
    attemptId: "attempt-1",
    epoch: 1,
  },
  credential: {
    kind: "registration",
    capability: "one-use-secret",
  },
  handshakeId: "provisioned-handshake-id",
  capacity: 1,
  applicationConfig: "./oxian.config.ts",
  credentialStore: {
    mode: "durable",
    path: "./state/resume.json",
  },
} as const;
```

Do not generate `handshakeId` dynamically in the manifest module: it must remain
stable with the provisioned credential.

### `loadWorkerManifest`

```ts
function loadWorkerManifest(
  source: LoadWorkerManifestSource,
): Promise<WorkerManifest>;
```

`source` must be a local `.ts` path or `file:` URL without a query or fragment.
The module must export exactly one of `default` or `manifest` and no other
runtime exports. Loading imports the module, selects that value, rejects unknown
keys and accessors, validates all worker protocol fields, and returns a frozen
normalized manifest.

Manifest rules:

- `gatewayUrl` must be credential-free `wss:` without query or fragment. Plain
  `ws:` is accepted only for `localhost`, `127.0.0.1`, or IPv6 loopback.
- `identity`, `credential`, `handshakeId`, `capacity`, `applicationConfig`, and
  `credentialStore` are required.
- A resume credential requires a non-negative safe `resumeExpiresAtMs`; that
  field is forbidden for a registration credential.
- `applicationConfig` must resolve to a local `.ts` module without query or
  fragment.
- `credentialStore` is exactly `{ mode: "ephemeral" }` or
  `{ mode: "durable", path }`.
- Relative application and durable-store paths are resolved relative to the
  manifest module, not the process working directory.

The initial registration capability in a manifest is normally consumed on the
first successful connection. A durable credential store lets subsequent
processes use the rotated resume capability without rewriting the provisioned
manifest.

## Atomic resume-credential store

### Types

```ts
type WorkerResumeCredentialState = Readonly<{
  schema: "oxian.worker-resume.v1";
  identity: WorkerIdentity;
  credential: Readonly<{
    kind: "resume";
    capability: string;
  }>;
  handshakeId: string;
  resumeExpiresAtMs: number;
}>;

type AtomicResumeCredentialStore = Readonly<{
  path: string;
  load(): Promise<WorkerResumeCredentialState | undefined>;
  persist(
    update: WorkerResumeCredentialUpdate,
    context: Readonly<{ signal: AbortSignal }>,
  ): void | Promise<void>;
  close(): Promise<void>;
}>;
```

`WorkerResumeCredentialUpdate`, used by `persist`, contains:

```ts
type WorkerResumeCredentialUpdate = Readonly<{
  credential: Readonly<{
    kind: "resume";
    capability: string;
  }>;
  replacesHandshakeId: string;
  handshakeId: string;
  resumeExpiresAtMs: number;
}>;
```

### `createAtomicResumeCredentialStore`

```ts
function createAtomicResumeCredentialStore(
  options: Readonly<{
    path: string;
    identity: WorkerIdentity;
    initialHandshakeId: string;
  }>,
): AtomicResumeCredentialStore;
```

The returned `path` is absolute. Ownership is acquired lazily by `load` or
`persist`; an advisory `${path}.lock` remains exclusively held until `close()`.
The implementation also prevents two stores in the same process from owning the
same normalized path.

`load` returns `undefined` if no state file exists. Existing content must be
strict `oxian.worker-resume.v1` JSON for the exact manifest identity.

`persist` is serialized and compare-and-set:

- the first update must replace `initialHandshakeId`;
- later updates must name the stored handshake as `replacesHandshakeId`; and
- replaying the exact already-stored candidate is idempotent, while a different
  candidate with the same handshake is rejected.

Commits create the parent directory with mode `0700`, write a same-directory
temporary file with mode `0600`, flush it, atomically rename it, and attempt a
directory fsync. Accepted credentials are never partially serialized to the
target path. `close()` waits for queued writes, releases the lock, is
idempotent, and makes later `load` or `persist` reject.

The store provides single-host file durability, not distributed consensus or
shared-network-filesystem locking guarantees.

## Manifest worker runtime

### Types

```ts
type ManifestWorkerRuntimeOptions = Readonly<{
  manifest: WorkerManifest;
}>;

type ManifestWorkerRuntimeRunning = Readonly<{
  router: FileRouter<unknown>;
  application: Application<unknown>;
  worker: WorkerClient;
  workerRun: Promise<WorkerClientResult>;
}>;

type ManifestWorkerRuntime = Readonly<{
  start(): Promise<ManifestWorkerRuntimeRunning>;
  stop(reason?: string): Promise<void>;
  readonly finished: Promise<void>;
  snapshot(): Readonly<{
    state: LocalRuntimeState;
    worker?: ReturnType<WorkerClient["snapshot"]>;
  }>;
}>;
```

### `createManifestWorkerRuntime`

```ts
function createManifestWorkerRuntime(
  options: ManifestWorkerRuntimeOptions,
): ManifestWorkerRuntime;
```

This factory accepts an already validated `WorkerManifest`; use
`loadWorkerManifest` at an untrusted module boundary.

On `start()`, the runtime loads the manifest's application configuration,
creates its configured application and HTTP workload, then connects a
`WorkerClient` to `gatewayUrl`. With a durable store it first loads any current
resume credential and supplies the store's compare-and-set persister to the
client. With an ephemeral store, credential rotation is kept only in memory.
Insecure WebSocket transport is enabled only for a manifest URL already
validated as loopback. `start()` resolves after the worker reaches ready.

Repeated starts share one promise. `stop(reason)` aborts connection attempts,
stops the worker, disposes the application, closes the credential store, and is
idempotent; its default reason is `"worker_runtime_stopped"`. The runtime cannot
restart after stop or failure. `finished` resolves after an orderly stop or a
server-requested shutdown and rejects after other worker failures. Those
failures use an error named `ManifestWorkerRuntimeError`.

The runtime owns its application and worker objects, but it still does not own
process signals or `Deno.exitCode`; the `/bin` CLI entrypoint supplies that
outer policy.
