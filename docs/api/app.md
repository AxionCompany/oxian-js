# `jsr:@oxian/oxian-js@0.20.0-rc.1/app`

[Back to the API reference](../api-reference.md)

The `/app` subpath creates Fetch-native applications, composes their middleware
and lifecycle, loads explicit application factories, and creates server-sent
event streams.

All examples on this page pin the 0.20 release candidate:

```ts
import {
  createApplication,
  createServerSentEvents,
  defineApplicationFactory,
} from "jsr:@oxian/oxian-js@0.20.0-rc.1/app";
```

## Export summary

### Values

| Export                        | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `createApplication`           | Initialize one immutable application instance.           |
| `createConfiguredApplication` | Compose normalized config into a router and application. |
| `defineApplicationFactory`    | Validate and freeze an application factory boundary.     |
| `loadApplicationFactory`      | Import one local TypeScript factory module.              |
| `runMiddleware`               | Execute an immutable onion middleware chain.             |
| `createServerSentEvents`      | Create a native streaming SSE response and writer.       |

### Types

| Export                               | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `Application`                        | A running application instance.                    |
| `ApplicationOptions`                 | Router, state, middleware, and lifecycle hooks.    |
| `ApplicationSetupContext`            | Context passed to `setup`.                         |
| `ApplicationDisposeContext`          | Context passed to the dispose hook.                |
| `ApplicationErrorContext`            | Request context passed to `onError`.               |
| `ApplicationSnapshot`                | Synchronous lifecycle counters.                    |
| `ApplicationFactory`                 | Factory function contract.                         |
| `ApplicationFactoryContext`          | Runtime-owned inputs passed to a factory.          |
| `LoadApplicationFactorySource`       | Accepted factory module source type.               |
| `ConfiguredApplication`              | Router/application pair from configuration.        |
| `CreateConfiguredApplicationOptions` | Inputs to `createConfiguredApplication`.           |
| `ServerSentEventOptions`             | Per-event SSE fields.                              |
| `ServerSentEventsOptions`            | SSE response, buffering, and cancellation options. |
| `ServerSentEvents`                   | SSE response and serialized writer operations.     |

## `createApplication`

```ts
function createApplication<State = undefined>(
  options: ApplicationOptions<State>,
): Promise<Application<State>>;
```

`createApplication` initializes state once and returns a frozen application. The
supplied `FileRouter` is already a startup snapshot: route modules are not
loaded by this function or during requests.

```ts
import { createApplication } from "jsr:@oxian/oxian-js@0.20.0-rc.1/app";
import { createFileRouter } from "jsr:@oxian/oxian-js@0.20.0-rc.1/router";

const router = await createFileRouter<{ startedAt: number }>({
  root: "./routes",
});

const application = await createApplication({
  router,
  basePath: "/api",
  setup: () => ({ startedAt: Date.now() }),
  dispose: async (state, { reason, signal }) => {
    console.log("disposing", state.startedAt, reason, signal.aborted);
  },
});
```

`ApplicationOptions<State>` is the following state-aware contract:

```ts
type ApplicationOptions<State> =
  & Readonly<{
    router: FileRouter<State>;
    basePath?: string;
    middleware?: readonly RouteMiddleware<State>[];
    onError?: (
      error: unknown,
      context: ApplicationErrorContext<State>,
    ) => Response | Promise<Response>;
    dispose?: (
      state: State,
      context: ApplicationDisposeContext,
    ) => void | Promise<void>;
  }>
  & (
    | Readonly<{ state: State; setup?: never }>
    | Readonly<{
      setup: (
        context: ApplicationSetupContext,
      ) => State | Promise<State>;
      state?: never;
    }>
    | (
      undefined extends State ? Readonly<{
          state?: never;
          setup?: never;
        }>
        : never
    )
  );
```

The third branch makes omitting both state sources type-safe only when
`undefined` is assignable to `State`.

- `router` must be a `FileRouter` compatible with the application state.
- `basePath` defaults to `/`. It must be `/` or a canonical absolute path made
  from unescaped ASCII letters, digits, `.`, `_`, `~`, and `-`, with no empty,
  `.` or `..` segment and no trailing slash. A mount such as `/api` matches
  `/api` and `/api/...`, never `/apiary`.
- `state` installs an already-created value.
- `setup` runs once before the promise resolves. Its lifecycle signal is aborted
  if setup fails or when the application is disposed.
- `middleware` runs before route-directory middleware, in array order.
- `onError` contains route, middleware, and matching failures. If it throws or
  returns anything other than a `Response`, Oxian returns a generic 500.
- `dispose` runs once, after active responses have settled. Its signal is the
  application lifecycle signal and is already aborted when the hook runs.

Supplying both `state` and `setup` throws `TypeError`. Invalid middleware,
hooks, base paths, or router-shaped values are also rejected before setup runs.
A setup rejection aborts its signal and becomes the `createApplication`
rejection.

### Request behavior

```ts
application.fetch(request: Request): Promise<Response>
```

`fetch` requires a native `Request`; another value throws `TypeError`. For an
accepted request it:

1. combines `request.signal` with the application lifecycle signal;
2. removes the exact `basePath` mount;
3. synchronously matches the router;
4. runs global and route-directory middleware around the selected handler;
5. tracks the returned body until EOF, error, cancellation, or lifecycle abort.

The built-in HTTP outcomes are:

| Condition                                       | Result                                     |
| ----------------------------------------------- | ------------------------------------------ |
| Path is outside the mount or no route matches   | `404 Not Found`                            |
| Method has no handler                           | `405 Method Not Allowed` with `Allow`      |
| `OPTIONS` has no explicit handler               | `204 No Content` with `Allow`              |
| `HEAD` has no explicit handler but `GET` exists | Run `GET`, then remove and cancel its body |
| URL path has malformed percent encoding         | `400 Bad Request`                          |
| Application has begun disposal                  | `503 Service Unavailable`                  |
| Unhandled application error                     | `onError`, or a generic `500`              |

`Allow` is ordered as `GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`, excluding
unsupported methods. `HEAD` is implied by `GET`, and `OPTIONS` is always
available.

The active-request counter includes response streaming, not just handler
execution. If a caller never consumes a response body, disposal aborts that body
before waiting for it to settle.

### `Application`

```ts
type Application<State> = Readonly<{
  readonly router: FileRouter<State>;
  readonly basePath: string;
  readonly state: State;
  fetch(request: Request): Promise<Response>;
  dispose(reason?: unknown): Promise<void>;
  snapshot(): ApplicationSnapshot;
}>;
```

`dispose(reason = "application_disposed")` is idempotent and returns the same
promise on every call. It stops new admission, synchronously aborts the
lifecycle signal, waits for all accepted response bodies, then awaits the
dispose hook. A dispose-hook error rejects that stable promise.

```ts
type ApplicationSnapshot = Readonly<{
  acceptingRequests: boolean;
  activeRequests: number;
}>;
```

`snapshot()` is synchronous. It reports process-local state for this application
instance; it is not a durable or cross-worker metric.

### Lifecycle context types

```ts
type ApplicationSetupContext = Readonly<{
  signal: AbortSignal;
}>;

type ApplicationDisposeContext = Readonly<{
  reason: unknown;
  signal: AbortSignal;
}>;

type ApplicationErrorContext<State> = Readonly<{
  request: Request;
  route?: CompiledRoute<State>;
  params?: RouteParams;
  state: State;
  signal: AbortSignal;
}>;
```

`route` and `params` are present when matching completed before the error. They
are absent for failures that occur before a route is selected.

## `runMiddleware`

```ts
function runMiddleware<State>(
  request: Request,
  context: RouteContext<State>,
  middleware: readonly RouteMiddleware<State>[],
  handler: RouteHandler<State>,
): Promise<Response>;
```

`runMiddleware` runs an onion chain and validates that every middleware and the
terminal handler return a native `Response`.

```ts
const response = await runMiddleware(
  request,
  context,
  [
    async (_request, _context, next) => {
      const response = await next();
      response.headers.set("server-timing", "route;dur=1");
      return response;
    },
  ],
  () => Response.json({ ok: true }),
);
```

Each middleware may call `next()` at most once and only before that middleware
settles. Violations throw `TypeError`. Oxian joins a downstream promise even
when middleware calls `next()` without awaiting or returning it, so detached
handlers cannot escape lifecycle accounting. Middleware may deliberately catch a
downstream error and return a replacement `Response`.

Applications normally call this through `Application.fetch`; the direct export
is useful when composing the same route contracts outside an application.

## Application factories

Factories let application code install state, lifecycle hooks, or global
middleware while the runtime retains ownership of the router and mount.

### `ApplicationFactoryContext`

```ts
type ApplicationFactoryContext<State = unknown> = Readonly<{
  router: FileRouter<State>;
  basePath: string;
  signal: AbortSignal;
}>;

type ApplicationFactory<State = unknown> = (
  context: ApplicationFactoryContext<State>,
) => Application<State> | Promise<Application<State>>;

type LoadApplicationFactorySource = string | URL;
```

The runtime provides the exact router, a canonical base path, and a setup
deadline/cancellation signal. The factory must return an application that uses
that same router and base path.

### `defineApplicationFactory`

```ts
function defineApplicationFactory<State = unknown>(
  factory: ApplicationFactory<State>,
): ApplicationFactory<State>;
```

This function rejects non-functions immediately and returns a frozen wrapper. On
each call the wrapper:

- validates and freezes a fresh factory context;
- canonicalizes `context.basePath`;
- awaits the user factory;
- requires a frozen, plain `Application` object with exactly the enumerable data
  properties `router`, `basePath`, `state`, `fetch`, `dispose`, and `snapshot`;
- requires the exact supplied router and canonical base path.

If the returned object fails validation but exposes a data-property `dispose`
function, Oxian calls it best-effort with `"application_factory_rejected"`.
Cleanup failure never replaces the boundary validation error.

```ts
import {
  createApplication,
  defineApplicationFactory,
} from "jsr:@oxian/oxian-js@0.20.0-rc.1/app";

export default defineApplicationFactory(
  ({ router, basePath }) =>
    createApplication({
      router,
      basePath,
      setup: () => ({ startedAt: Date.now() }),
    }),
);
```

### `loadApplicationFactory`

```ts
function loadApplicationFactory<State = unknown>(
  source: LoadApplicationFactorySource,
): Promise<ApplicationFactory<State>>;
```

The source must be a local `.ts` filesystem path or local `file:` URL, without a
query or fragment. The imported module must export exactly one value: a default
factory. Named or additional exports are rejected. The result is wrapped with
`defineApplicationFactory`, so the same runtime checks apply.

Dynamic import, filesystem, or module-evaluation failures reject the promise
unchanged.

## Configured applications

### `createConfiguredApplication`

```ts
function createConfiguredApplication(
  options: CreateConfiguredApplicationOptions,
): Promise<ConfiguredApplication>;
```

```ts
type CreateConfiguredApplicationOptions = Readonly<{
  config: ApplicationConfig;
  signal: AbortSignal;
  createRouter?: (
    options: CreateFileRouterOptions,
  ) => Promise<FileRouter<unknown>>;
}>;

type ConfiguredApplication = Readonly<{
  router: FileRouter<unknown>;
  application: Application<unknown>;
}>;
```

The function creates a router from `config.routesRoot`, then either creates the
default stateless application or loads and invokes `config.factory`. The
normalized `config.basePath` is passed through in both cases.

`signal` is required and checked before and after asynchronous router and
factory work. If cancellation wins after an application has been constructed,
Oxian disposes it before rethrowing the abort. Other composition failures use
`"application_configuration_failed"` as the best-effort disposal reason.

`createRouter` is an optional composition seam with the same contract as
`createFileRouter`; production callers normally omit it.

## Server-sent events

### `createServerSentEvents`

```ts
function createServerSentEvents(
  options?: ServerSentEventsOptions,
): ServerSentEvents;
```

```ts
type ServerSentEventsOptions = Readonly<{
  signal?: AbortSignal;
  status?: number; // default: 200
  headers?: HeadersInit;
  retry?: number;
  maxEventBytes?: number; // default: 65_536
  bufferBytes?: number; // default: 65_536
}>;

type ServerSentEventOptions = Readonly<{
  event?: string;
  id?: string;
  retry?: number;
}>;

type ServerSentEvents = Readonly<{
  response: Response;
  send(data: unknown, options?: ServerSentEventOptions): Promise<void>;
  comment(text: string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  readonly closed: Promise<void>;
}>;
```

The returned `response` streams bytes from the writer. Oxian always removes
`Content-Length` and `Transfer-Encoding`, then sets:

```text
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

Other caller headers are preserved. `status` must be a body-compatible HTTP
status from 200 through 599; 204, 205, and 304 are rejected.

Writes are serialized and honor stream backpressure:

- `send` writes strings verbatim as SSE data. Other values use `JSON.stringify`;
  a value that JSON does not represent becomes `null`.
- Multiline data becomes one `data:` field per line.
- `event` and `id` must not contain CR or LF.
- Per-event and initial `retry` values must be non-negative safe integers.
- `comment` emits one SSE comment field per input line.
- The complete UTF-8 encoded event or comment must fit `maxEventBytes`.

`maxEventBytes` and `bufferBytes` must be positive safe integers. Passing
`options.retry` queues an initial retry field before later writes.

```ts
import { createServerSentEvents } from "jsr:@oxian/oxian-js@0.20.0-rc.1/app";

const events = createServerSentEvents({
  signal: request.signal,
  retry: 5_000,
});

void (async () => {
  try {
    await events.send(
      { state: "ready" },
      { event: "state", id: "1" },
    );
    await events.comment("heartbeat");
    await events.close();
  } catch (error) {
    await events.abort(error);
  }
})();

return events.response;
```

`close()` is idempotent and drains queued writes before closing. `abort()`
defaults its reason to `"sse_aborted"`, is idempotent, and can preempt a
backpressured close. Aborting `options.signal` calls `abort(signal.reason)`.
Once closing begins, new writes reject with `TypeError`. `closed` settles after
either normal close or abort and does not reject.

## Ownership notes

An `Application` owns only its in-process state, accepted requests, response
bodies, and lifecycle signal. It does not own the listener, worker connection,
provider resource, durable checkpoint, or cross-replica routing. Those remain at
their HTTP, worker, provider, and application-infrastructure boundaries.
