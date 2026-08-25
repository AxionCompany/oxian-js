# `jsr:@oxian/oxian-js@0.21.0/http`

[Back to the API reference](../api-reference.md)

The `/http` subpath adapts native Fetch requests and responses to the versioned
Oxian workload protocol. It preserves streaming bodies, cancellation, repeated
headers such as `Set-Cookie`, and strict metadata validation.

```ts
import {
  createHttpGateway,
  createHttpWorkload,
  HTTP_WORKLOAD,
} from "jsr:@oxian/oxian-js@0.21.0/http";
```

## Export summary

### Values

| Export                          | Purpose                                                       |
| ------------------------------- | ------------------------------------------------------------- |
| `HTTP_REQUEST_METADATA_SCHEMA`  | Request metadata schema ID, `oxian.http.request.v1`.          |
| `HTTP_RESPONSE_METADATA_SCHEMA` | Response metadata schema ID, `oxian.http.response.v1`.        |
| `HTTP_WORKLOAD`                 | Default workload ID, `oxian.http.v1`.                         |
| `HTTP_METADATA_LIMITS`          | Frozen HTTP metadata limits.                                  |
| `createHeaders`                 | Rebuild a native `Headers` object from ordered pairs.         |
| `encodeHttpRequestMetadata`     | Convert a native `Request` into validated request metadata.   |
| `decodeHttpRequestMetadata`     | Strictly validate request metadata.                           |
| `encodeHttpResponseMetadata`    | Convert a native `Response` into validated response metadata. |
| `decodeHttpResponseMetadata`    | Strictly validate response metadata.                          |
| `rechunkHttpBody`               | Bound a byte stream to v1 data-frame payload chunks.          |
| `createHttpGateway`             | Adapt HTTP ingress to a host-compatible dispatch function.    |
| `createHttpWorkload`            | Adapt a worker operation to a Fetch handler.                  |

### Types

| Export                 | Purpose                                         |
| ---------------------- | ----------------------------------------------- |
| `HttpHeaderPair`       | Ordered `[name, value]` header representation.  |
| `HttpRequestMetadata`  | Strict `oxian.http.request.v1` metadata.        |
| `HttpResponseMetadata` | Strict `oxian.http.response.v1` metadata.       |
| `HttpMetadataLimits`   | Shape of `HTTP_METADATA_LIMITS`.                |
| `HttpDispatch`         | Worker-host-compatible dispatch function.       |
| `HttpGatewayDeadline`  | Per-request absolute deadline callback.         |
| `HttpGatewayOptions`   | HTTP gateway construction options.              |
| `HttpGateway`          | Fetch-compatible asynchronous gateway function. |
| `HttpFetchHandler`     | Fetch handler executed inside a worker.         |
| `HttpWorkloadOptions`  | HTTP workload construction options.             |

## Metadata constants and types

```ts
const HTTP_REQUEST_METADATA_SCHEMA = "oxian.http.request.v1";
const HTTP_RESPONSE_METADATA_SCHEMA = "oxian.http.response.v1";
const HTTP_WORKLOAD = "oxian.http.v1";

type HttpHeaderPair = readonly [name: string, value: string];

type HttpRequestMetadata =
  & JsonObject
  & Readonly<{
    schema: typeof HTTP_REQUEST_METADATA_SCHEMA;
    requestId: string;
    method: string;
    url: string;
    headers: readonly HttpHeaderPair[];
    hasBody: boolean;
  }>;

type HttpResponseMetadata =
  & JsonObject
  & Readonly<{
    schema: typeof HTTP_RESPONSE_METADATA_SCHEMA;
    status: number;
    statusText: string;
    headers: readonly HttpHeaderPair[];
    hasBody: boolean;
  }>;
```

Metadata uses ordered header pairs instead of a record so duplicate fields are
not lost. Encoders lowercase header names and preserve individual `Set-Cookie`
values when the runtime exposes `Headers.getSetCookie()`.

`hasBody` describes the credited binary stream that follows the metadata. It is
not inferred by a decoder. Request metadata rejects a body for `GET` and `HEAD`;
response metadata rejects a body for status `204`, `205`, or `304`.

## Metadata limits

```ts
type HttpMetadataLimits = Readonly<{
  maxRequestIdLength: number;
  maxMethodLength: number;
  maxUrlLength: number;
  maxHeaderCount: number;
  maxHeaderNameLength: number;
  maxHeaderValueLength: number;
  maxStatusTextLength: number;
  maxMetadataBytes: number;
}>;

const HTTP_METADATA_LIMITS: HttpMetadataLimits;
```

The exported frozen value contains:

| Field                  | Value               |
| ---------------------- | ------------------- |
| `maxRequestIdLength`   | 128 characters      |
| `maxMethodLength`      | 64 characters       |
| `maxUrlLength`         | 16,384 characters   |
| `maxHeaderCount`       | 256 pairs           |
| `maxHeaderNameLength`  | 256 characters      |
| `maxHeaderValueLength` | 16,384 characters   |
| `maxStatusTextLength`  | 1,024 characters    |
| `maxMetadataBytes`     | 60 KiB encoded JSON |

The 60 KiB metadata bound leaves 4 KiB inside the protocol's 64 KiB control
frame limit for the enclosing work frame.

## Metadata codecs

### `createHeaders`

```ts
function createHeaders(pairs: readonly HttpHeaderPair[]): Headers;
```

Creates a new `Headers` instance and appends pairs in order. Native `Headers`
validation remains authoritative, so malformed names or values throw from the
platform.

### `encodeHttpRequestMetadata`

```ts
function encodeHttpRequestMetadata(
  request: Request,
  requestId: string,
): HttpRequestMetadata;
```

Copies method, absolute URL, headers, and body presence from `request`, then
runs the same strict validation as the decoder. The returned metadata, header
array, and pairs are frozen. URL parsing canonicalizes the returned `url` to
`URL.href`.

### `decodeHttpRequestMetadata`

```ts
function decodeHttpRequestMetadata(
  value: JsonObject,
): HttpRequestMetadata;
```

The decoder accepts only a plain object with exactly `schema`, `requestId`,
`method`, `url`, `headers`, and `hasBody`. It requires:

- the exact request schema;
- a non-empty request ID within its limit;
- a non-empty HTTP-token method;
- an absolute `http:` or `https:` URL;
- a dense header array with exactly two strings per pair;
- valid HTTP-token header names and native-valid header values;
- a boolean body flag compatible with the method; and
- encoded JSON within `HTTP_METADATA_LIMITS.maxMetadataBytes`.

Malformed values throw `TypeError` with a field path beginning
`Invalid HTTP workload metadata at ...`.

### `encodeHttpResponseMetadata`

```ts
function encodeHttpResponseMetadata(
  response: Response,
  options?: Readonly<{ hasBody?: boolean }>,
): HttpResponseMetadata;
```

Copies status, status text, and ordered headers from a native `Response`.
`hasBody` defaults to `response.body !== null`; callers such as
`createHttpWorkload` override it for `HEAD`. The result passes through the
strict response decoder and is frozen.

### `decodeHttpResponseMetadata`

```ts
function decodeHttpResponseMetadata(
  value: JsonObject,
): HttpResponseMetadata;
```

The decoder accepts only the six exact response fields. Status must be a safe
integer from 200 through 599. Status text may be empty but cannot contain CR or
LF. Header and total-size rules are the same as request metadata.

## `rechunkHttpBody`

```ts
function rechunkHttpBody(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array>;
```

Returns a demand-driven stream whose chunks never exceed
`WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes` (1 MiB). Larger source chunks are
emitted as views without copying. Empty chunks are skipped.

The adapter uses a zero high-water mark, so it does not pull ahead of downstream
demand. Consumer cancellation reaches the source reader. A source that yields
anything other than `Uint8Array` errors the returned stream with `TypeError` and
cancels the source.

## HTTP gateway

### Types

```ts
type HttpDispatch = (
  input: WorkInput,
) => Promise<WorkHandle>;

type HttpGatewayDeadline = (
  request: Request,
) => number | undefined;

type HttpGatewayOptions = Readonly<{
  dispatch: HttpDispatch;
  workload?: string;
  createRequestId?: () => string;
  deadlineAtMs?: HttpGatewayDeadline;
}>;

type HttpGateway = (
  request: Request,
) => Promise<Response>;
```

`deadlineAtMs` returns an absolute Unix timestamp in milliseconds, not a
duration. A returned value must be a non-negative safe integer.

### `createHttpGateway`

```ts
function createHttpGateway(options: HttpGatewayOptions): HttpGateway;
```

The factory requires `dispatch`. `workload` defaults to `HTTP_WORKLOAD`, and
request IDs default to `crypto.randomUUID()`. A custom workload must be 1–128
characters, begin with an alphanumeric character, and otherwise contain only
letters, digits, `.`, `_`, `:`, `/`, or `-`.

For each native `Request`, the gateway:

1. validates that the request is not already aborted;
2. encodes request metadata and rechunks an optional body;
3. dispatches the operation, forwarding the request signal and optional absolute
   deadline;
4. waits for and validates the worker's response metadata;
5. returns a native `Response` backed directly by the credited output stream.

```ts
const gateway = createHttpGateway({
  dispatch: (input) => hypervisor.dispatch(input),
  deadlineAtMs: () => Date.now() + 30_000,
});

const response = await gateway(
  new Request("https://service.example/orders"),
);
```

Cancellation is bidirectional:

- aborting while metadata is pending calls `handle.cancel(...)` and rejects with
  the request's abort reason;
- cancelling the returned response body cancels the dispatch output and
  operation;
- a dispatch failure cancels an unread request body;
- invalid response metadata cancels with `invalid_http_response_metadata`; and
- data after metadata declared `hasBody: false` triggers best-effort operation
  cancellation.

The gateway does not translate dispatch failures into HTTP status codes. They
reject the returned promise so the surrounding application or server owns error
policy.

## HTTP workload

### Types

```ts
type HttpFetchHandler = (
  request: Request,
) => Response | Promise<Response>;

type HttpWorkloadOptions = Readonly<{
  fetch: HttpFetchHandler;
}>;
```

### `createHttpWorkload`

```ts
function createHttpWorkload(
  options: HttpWorkloadOptions,
): WorkerWorkHandler;
```

Requires a Fetch-compatible function and returns a frozen worker handler. The
handler validates the operation metadata before invoking user code, rebuilds a
native `Request`, forwards `WorkerWorkContext.signal`, and rechunks both request
and response streams.

```ts
const workload = createHttpWorkload({
  fetch: async (request) => {
    return Response.json({
      method: request.method,
      path: new URL(request.url).pathname,
    });
  },
});

const worker = createWorker({
  // ...
  workloads: { [HTTP_WORKLOAD]: workload },
});
```

The Fetch handler must return a native `Response`; another value throws
`TypeError`. For a `HEAD` request, Oxian advertises no response body and cancels
any body returned by the handler. It awaits that cancellation, so worker
execution capacity remains occupied until the owned source settles.

Invalid request metadata cancels the unread operation input before the error is
re-thrown. Invalid response metadata similarly cancels the response body. The
workload does not buffer either direction and does not interpret application
payloads.
