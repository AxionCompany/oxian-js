# `jsr:@oxian/oxian-js@0.21.0-rc.6/work`

The `/work` subpath is the minimal, runtime-neutral contract between callers and
an Oxian Hypervisor. Embedding libraries can depend on these types without
depending on HTTP, worker admission, or a runtime server adapter.

```ts
import type {
  Dispatcher,
  WorkBody,
  WorkHandle,
  WorkInput,
} from "jsr:@oxian/oxian-js@0.21.0-rc.6/work";
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
