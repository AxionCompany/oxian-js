# `jsr:@oxian/oxian-js@0.23.0/work`

The `/work` subpath is the minimal, runtime-neutral contract between callers and
an Oxian Hypervisor. Embedding libraries can depend on these types without
depending on HTTP, worker admission, or a runtime server adapter.

```ts
import type {
  Dispatcher,
  WorkBody,
  WorkHandle,
  WorkInput,
} from "jsr:@oxian/oxian-js@0.23.0/work";
```

## Exports

| Export       | Purpose                                                       |
| ------------ | ------------------------------------------------------------- |
| `WorkBody`   | A byte array or backpressured byte stream.                    |
| `WorkInput`  | One transport-neutral workload request.                       |
| `WorkHandle` | Streaming output and settlement for one accepted operation.   |
| `Dispatcher` | The minimal `dispatch` capability consumed by another module. |

## Input

```ts
type WorkBody = Uint8Array | ReadableStream<Uint8Array>;

type WorkInput = Readonly<{
  workload: string;
  target?: Readonly<{ workerId: string }>;
  metadata?: JsonObject;
  body?: WorkBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;
```

`workload` selects a declared handler. Omitting `target` allows the Hypervisor
to choose any ready Worker with capacity; a target names a logical Worker, never
a socket or attempt. `metadata` is bounded JSON control data. `body` carries
large or streaming bytes without JSON or base64 conversion.

## Handle

```ts
type WorkHandle = Readonly<{
  operationId: string;
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<WorkDispatch>;
  cancel(reason?: string): Promise<WorkDispatch>;
}>;
```

`started` resolves only after durable acceptance and the execution boundary.
`metadata` resolves once. `output` preserves backpressure and directional
cancellation. `completed` is the authoritative terminal dispatch state.

## Minimal dependency

```ts
type Dispatcher = Readonly<{
  dispatch(input: WorkInput): Promise<WorkHandle>;
}>;

export function createEmbeddedFeature(dispatcher: Dispatcher) {
  return Object.freeze({
    run: (body: ReadableStream<Uint8Array>) =>
      dispatcher.dispatch({ workload: "feature.run.v1", body }),
  });
}
```

This is a structural capability: a Hypervisor satisfies it directly, and tests
can supply one function without constructing transport infrastructure.

## Host calls

The same subpath exports `HostCaller`, `HostCallInput`, `HostCallHandle`,
`HostCallError`, `HostCallErrorCode`, `createHostCallError`, and
`isHostCallError` for optional calls in the reverse direction. Unlike
`Dispatcher`, `HostCaller` targets the authenticated connection's host, not a
selected Worker:

```ts
type HostCallInput = Readonly<{
  workload: string;
  metadata?: JsonObject;
  body?: WorkBody;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

type HostCaller = (input: HostCallInput) => Promise<HostCallHandle>;

type HostCallHandle = Readonly<{
  streamId: string;
  metadata: Promise<JsonObject>;
  output: ReadableStream<Uint8Array>;
  started: Promise<void>;
  completed: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;
```

There is no caller-supplied target, parent ID, or host-authentication claim.
`WorkerWorkContext.callHost` is assignment-bound; `Worker.callHost` is
parentless and needs separate host admission. Both require negotiated support.

`started` means the worker sent Start; `completed` means normal stream
completion. Neither promise proves durable application commit. A `HostCallError`
carries `execution: "not_started" | "indeterminate"`; once Start can have been
sent, failures are indeterminate, even if sending rejects. `HostCallErrorCode`
is `unsupported`, `unavailable`, `capacity`, `refused`, `cancelled`,
`deadline_exceeded`, `connection_lost`, `handler_failed`, or `payload_too_large`.
Recognized remote codes are preserved; unknown codes map to `refused`.
Execution ambiguity still depends on whether Start could have been sent.
`createHostCallError(code, execution, message?)` creates a marked `Error` with
those immutable fields; `isHostCallError(value)` is its type guard.
`HostCallError` is a type, not a custom class constructor.

Cancelling a fully completed handle is idempotent and cannot close the shared
connection. Cancelling after only one stream half ends still propagates normally.

Inspect `execution` independently of the error code. No call is automatically
replayed; the application owns idempotency and receipt recovery.

Request streams transfer to the channel when a handle is returned. Streamed
chunks are bounded to 1 MiB; larger direct byte arrays are split into frames.
See [worker-to-host calls](../worker-host-calls.md) for admission, cancellation,
source ownership, drain, and reconnect guarantees.
