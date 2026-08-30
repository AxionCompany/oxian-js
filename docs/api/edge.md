# `jsr:@oxian/oxian-js@0.21.1/edge`

[Back to the API reference](../api-reference.md)

The `/edge` subpath provides small Fetch-handler adapters for CORS, local static
files, and an HTTP development proxy. Each adapter wraps one handler and returns
another handler; it does not open a listener or own application lifecycle.

```ts
import {
  createCorsAdapter,
  createDevProxyAdapter,
  createStaticAdapter,
} from "jsr:@oxian/oxian-js@0.21.1/edge";
```

## Export summary

### Values

| Export                  | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `createCorsAdapter`     | Apply strict browser CORS response policy.           |
| `createStaticAdapter`   | Serve verified files from a local directory.         |
| `createDevProxyAdapter` | Reverse-proxy matching HTTP requests in development. |

### Types

| Export                   | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| `FetchHandler`           | Native request-to-response function.                |
| `FetchAdapter`           | Higher-order Fetch handler wrapper.                 |
| `CorsAdapterOptions`     | CORS origin, method, header, and credential policy. |
| `CorsOriginPolicy`       | Wildcard, exact list, or origin predicate.          |
| `CorsOriginPredicate`    | Async-capable origin decision function.             |
| `StaticAdapterOptions`   | Static root, mount, indexes, and metadata policy.   |
| `StaticContentType`      | Per-file content type callback.                     |
| `StaticCacheControl`     | Per-file cache-control callback.                    |
| `DevProxyAdapterOptions` | Upstream and prefix rewriting options.              |

## Common adapter types

```ts
type FetchHandler = (
  request: Request,
) => Response | Promise<Response>;

type FetchAdapter = (
  next: FetchHandler,
) => FetchHandler;
```

Adapters are composed from the innermost application outward. In this example,
CORS applies to both static and application responses, while only misses under
`/assets` reach the application:

```ts
import {
  createCorsAdapter,
  createStaticAdapter,
  type FetchHandler,
} from "jsr:@oxian/oxian-js@0.21.1/edge";

const application: FetchHandler = (request) =>
  new Response(`application: ${new URL(request.url).pathname}`);

const fetch = createCorsAdapter({
  origins: ["https://console.example"],
})(
  createStaticAdapter({
    root: "./public",
    prefix: "/assets",
  })(application),
);
```

Every returned adapter function validates that `next` is a function when it is
applied. Handler errors generally propagate unless a section below documents a
specific error response.

## CORS

### Types

```ts
type CorsOriginPredicate = (
  origin: string,
  request: Request,
) => boolean | Promise<boolean>;

type CorsOriginPolicy =
  | "*"
  | readonly string[]
  | CorsOriginPredicate;

type CorsAdapterOptions = Readonly<{
  origins: CorsOriginPolicy;
  methods?: readonly string[];
  headers?: readonly string[];
  exposeHeaders?: readonly string[];
  credentials?: boolean;
  maxAgeSeconds?: number;
}>;
```

`origins` is required and denied by default unless the wildcard, an exact list
entry, or a predicate permits the request origin.

Exact entries must be serialized HTTP(S) origins such as
`https://console.example`, or the opaque serialized origin `"null"`. They cannot
contain a path, query, fragment, or credentials. Entries are deduped.

The remaining defaults and normalization are:

| Option          | Default                  | Behavior                                |
| --------------- | ------------------------ | --------------------------------------- |
| `methods`       | All eight `HTTP_METHODS` | Valid HTTP tokens, uppercase, deduped.  |
| `headers`       | `[]`                     | Valid HTTP tokens, lowercase, deduped.  |
| `exposeHeaders` | `[]`                     | Valid HTTP tokens, lowercase, deduped.  |
| `credentials`   | `false`                  | Wildcard origins are forbidden if true. |
| `maxAgeSeconds` | absent                   | Must be a non-negative safe integer.    |

The default method order is
`GET, HEAD, QUERY, POST, PUT, PATCH, DELETE, OPTIONS`.

### `createCorsAdapter`

```ts
function createCorsAdapter(
  options: CorsAdapterOptions,
): FetchAdapter;
```

Configuration is validated when the adapter is created. A predicate is awaited
for each request that contains an `Origin` header; predicate errors reject the
handler call unchanged.

For a non-preflight request, CORS is a response policy:

- the wrapped handler always runs, even when the origin is denied;
- the managed Allow-Origin, Allow-Credentials, Allow-Methods, Allow-Headers,
  Expose-Headers, and Max-Age response fields are removed before policy is
  applied; other `Access-Control-*` fields are left untouched;
- an allowed origin receives `Access-Control-Allow-Origin`;
- configured credentials and exposed headers are added;
- exact-list and predicate policies merge `Origin` into `Vary`;
- wildcard policy uses `Access-Control-Allow-Origin: *` and does not vary on
  origin.

A request with no `Origin` header still reaches the wrapped handler. Wildcard
policy adds its wildcard grant; non-wildcard policy adds no grant.

A request is treated as a preflight only when it uses `OPTIONS` and contains
`Access-Control-Request-Method`. Preflight never invokes `next`.

Oxian returns `204 No Content` when all of these are true:

- origin policy permits the serialized origin;
- the requested method is a valid token in `methods`;
- requested header names are valid tokens and every one appears in `headers`.

The response advertises the configured methods and headers, credentials, and
optional max age. Invalid or denied preflight returns `403 Forbidden` without
CORS grants. Preflight responses merge `Origin`,
`Access-Control-Request-Method`, and `Access-Control-Request-Headers` into
`Vary` as applicable.

```ts
import { createCorsAdapter } from "jsr:@oxian/oxian-js@0.21.1/edge";

const withCors = createCorsAdapter({
  origins: async (origin, request) =>
    origin.endsWith(".example") &&
    request.headers.has("x-tenant"),
  methods: ["GET", "POST"],
  headers: ["content-type", "x-tenant"],
  exposeHeaders: ["x-request-id"],
  credentials: true,
  maxAgeSeconds: 600,
});

const fetch = withCors(() => Response.json({ ok: true }));
```

CORS is not authentication or authorization. A denied actual request still
executes application code; the browser is only denied a readable CORS grant.

## Static files

### Types

```ts
type StaticContentType = (
  path: string,
  info: Deno.FileInfo,
) => string | undefined;

type StaticCacheControl = (
  path: string,
  info: Deno.FileInfo,
) => string | undefined;

type StaticAdapterOptions = Readonly<{
  root: string | URL;
  prefix?: string;
  index?: string | readonly string[] | false;
  fallback?: string;
  cacheControl?: string | StaticCacheControl;
  contentType?: StaticContentType;
  fallthrough?: boolean;
}>;
```

`path` passed to metadata callbacks is the verified absolute real path of the
opened file. Returning `undefined` from `contentType` falls back to Oxian's
built-in extension map. Returning `undefined` from a cache-control callback
omits that header.

| Option         | Default          | Behavior                                           |
| -------------- | ---------------- | -------------------------------------------------- |
| `root`         | required         | Existing local directory path or `file:` URL.      |
| `prefix`       | `"/"`            | Absolute URL path; trailing slashes removed.       |
| `index`        | `["index.html"]` | String, ordered list, or `false` to disable.       |
| `fallback`     | absent           | Navigation fallback file under `root`.             |
| `cacheControl` | absent           | Fixed string or per-file callback.                 |
| `contentType`  | built-in map     | Optional per-file callback with built-in fallback. |
| `fallthrough`  | `true`           | Delegate misses instead of returning 404.          |

Prefixes reject queries, fragments, backslashes, null bytes, and `.` or `..`
segments. Index and fallback entries must be non-empty relative paths without
backslashes, empty segments, or traversal segments; index duplicates are
removed.

### `createStaticAdapter`

```ts
function createStaticAdapter(
  options: StaticAdapterOptions,
): FetchAdapter;
```

Adapter creation synchronously resolves `root` with `Deno.realPathSync` and
requires it to be a directory. A missing root, invalid URL protocol, invalid
option, or insufficient filesystem permission throws before a handler is
returned.

At request time:

- only `GET` and `HEAD` are candidates; every other method delegates to `next`,
  even when `fallthrough` is false;
- the prefix matches at a path-segment boundary, and requests outside it always
  delegate to `next` regardless of `fallthrough`;
- percent encoding is decoded before containment checks;
- directories try configured index files in order;
- missing or unsafe candidates inside the prefix delegate when `fallthrough` is
  true, otherwise return `404 Not Found`.

When `fallback` is configured, an exact-file miss delegates first when
`fallthrough` is true. If the resulting response is still 404, Oxian serves the
fallback only for a `GET` or `HEAD` request accepting HTML, text, or a wildcard
media range at an extensionless path. Fetch Metadata is treated as advisory
because browsers and service workers do not preserve it consistently: an
explicit asset destination still rejects the fallback, while an absent or
`empty` destination may receive it. JSON-only requests, asset paths with file
extensions, non-404 application responses, malformed paths, and unsafe paths
never receive the fallback. Put API applications at a more-specific mount so
they retain priority over a parent SPA fallback.

Malformed encoding, backslashes, null bytes, traversal, files outside the
configured root, missing files, and unsafe filesystem targets are treated as
inside-prefix misses.

```ts
import { createStaticAdapter } from "jsr:@oxian/oxian-js@0.21.1/edge";

const withAssets = createStaticAdapter({
  root: new URL("../public/", import.meta.url),
  prefix: "/assets",
  index: ["index.html", "fallback.html"],
  cacheControl: (path) =>
    path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
  fallthrough: false,
});

const fetch = withAssets(() => new Response("application"));
```

Every candidate is checked lexically and after real-path resolution. Oxian
rejects symlink escapes and verifies that the opened handle still identifies the
checked file, reducing path-replacement races. Symlinks whose resolved target
remains inside the configured root may be served.

### Response metadata and streaming

A successful `200` or `206` file response includes:

- `Content-Length`;
- `Accept-Ranges: bytes`;
- a size-and-modification-time `ETag`;
- `Last-Modified` when filesystem metadata provides it;
- configured cache control when present;
- a configured or built-in content type when known.

The built-in map covers common HTML, CSS, JavaScript, JSON, text, XML, image,
font, audio, video, PDF, WebAssembly, source-map, CSV, and binary extensions.
Unknown extensions omit `Content-Type` unless the callback supplies one.

Conditional requests support:

- `If-None-Match`, including weak comparison and `*`;
- `If-Modified-Since` when `If-None-Match` is absent;
- strong ETag or date `If-Range`.

A matching cache validator returns `304 Not Modified`. One byte range in
`bytes=start-end`, open-ended, or suffix form returns `206 Partial Content` with
`Content-Range`. An invalid, unsatisfiable, or multiple range returns
`416 Range Not Satisfiable` when `If-Range` permits range processing. A failed
`If-Range` causes the full `200` response instead.

`HEAD` returns the same status and metadata, including range metadata, without a
body. File bodies stream in bounded chunks and close their file handle on EOF,
error, or consumer cancellation. A file truncated after metadata was read
surfaces a stream error instead of silently returning fewer bytes.

Metadata callback failures reject the request and close the opened file.

## Development proxy

### `DevProxyAdapterOptions`

```ts
type DevProxyAdapterOptions = Readonly<{
  upstream: string | URL;
  prefix?: string;
  stripPrefix?: boolean;
  forwardHost?: boolean;
}>;
```

| Option        | Default  | Behavior                                              |
| ------------- | -------- | ----------------------------------------------------- |
| `upstream`    | required | Absolute `http:` or `https:` URL.                     |
| `prefix`      | `"/"`    | Incoming segment-boundary mount.                      |
| `stripPrefix` | `false`  | Remove a non-root prefix before joining the upstream. |
| `forwardHost` | `false`  | Put original authority in `X-Forwarded-Host`.         |

The upstream may contain a base pathname, but may not contain credentials,
query, or fragment. The prefix rejects queries, fragments, backslashes, null
bytes, and traversal segments; trailing slashes are removed.

### `createDevProxyAdapter`

```ts
function createDevProxyAdapter(
  options: DevProxyAdapterOptions,
): FetchAdapter;
```

Requests outside the configured prefix delegate to `next`. Matching requests are
sent with native `fetch`; `next` is not a failure fallback.

For an upstream of `http://127.0.0.1:5173/base`, prefix `/vite`, and request
`/vite/app.js?dev=1`:

| `stripPrefix` | Target URL                                     |
| ------------- | ---------------------------------------------- |
| `false`       | `http://127.0.0.1:5173/base/vite/app.js?dev=1` |
| `true`        | `http://127.0.0.1:5173/base/app.js?dev=1`      |

The adapter:

- preserves the incoming method, query, body stream for body-bearing methods,
  and abort signal;
- uses manual redirect handling;
- removes `Host`, standard hop-by-hop headers, and headers named by
  `Connection`;
- lets native fetch supply the upstream `Host`;
- optionally sets `X-Forwarded-Host` to the original authority;
- streams the upstream response and preserves end-to-end response headers,
  including multiple `Set-Cookie` values;
- removes response hop-by-hop and connection-specific headers.

```ts
import { createDevProxyAdapter } from "jsr:@oxian/oxian-js@0.21.1/edge";

const withVite = createDevProxyAdapter({
  upstream: "http://127.0.0.1:5173",
  prefix: "/vite",
  stripPrefix: true,
  forwardHost: true,
});

const fetch = withVite(() => new Response("application"));
```

An upstream connection or fetch failure becomes `502 Bad Gateway`. If the
downstream request signal is aborted, the original error is rethrown instead.

This adapter intentionally supports HTTP(S) only. It does not proxy WebSocket
upgrades, inject authentication, retry requests, or manage a development server
process.

## Ownership notes

Edge adapters are request-local composition. CORS owns response policy, static
serving owns file handles opened for a response, and the development proxy owns
one outbound fetch. Listener shutdown, application disposal, worker transport,
credentials, and provider resources remain outside this module.
