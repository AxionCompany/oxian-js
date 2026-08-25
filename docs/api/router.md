# `jsr:@oxian/oxian-js@0.21.0/router`

[Back to the API reference](../api-reference.md)

The `/router` subpath compiles a filesystem route tree once and exposes pure,
synchronous request-path matching. Route handlers use native `Request`,
`Response`, `AbortSignal`, and promises.

```ts
import {
  createFileRouter,
  HTTP_METHODS,
} from "jsr:@oxian/oxian-js@0.21.0/router";
```

## Export summary

### Values

| Export             | Purpose                                             |
| ------------------ | --------------------------------------------------- |
| `createFileRouter` | Discover, import, validate, and freeze route files. |
| `HTTP_METHODS`     | Supported named HTTP method exports.                |

### Types

| Export                    | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `CreateFileRouterOptions` | Filesystem root passed to `createFileRouter`.     |
| `FileRouter`              | Immutable route snapshot and matcher.             |
| `HttpMethod`              | Union derived from `HTTP_METHODS`.                |
| `RouteHandler`            | Named HTTP route handler.                         |
| `RouteMiddleware`         | Onion middleware function.                        |
| `RouteContext`            | State, params, route metadata, and signal.        |
| `RouteMethods`            | Partial method-to-handler map.                    |
| `RouteParams`             | Read-only parameter record.                       |
| `RouteParamValue`         | One parameter string or catchall string array.    |
| `RouteSegment`            | Static, parameter, or catchall segment union.     |
| `StaticRouteSegment`      | Compiled literal segment.                         |
| `ParamRouteSegment`       | Compiled single-value parameter.                  |
| `CatchallRouteSegment`    | Compiled one-or-more-values catchall.             |
| `CompiledRoute`           | Immutable pattern, source, segments, and methods. |
| `CompiledMiddleware`      | Immutable middleware function and source.         |
| `RouteMatch`              | Selected route, params, and middleware chain.     |

## `HTTP_METHODS` and `HttpMethod`

```ts
const HTTP_METHODS: readonly [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "QUERY",
  "HEAD",
  "OPTIONS",
];

type HttpMethod = (typeof HTTP_METHODS)[number];
```

A route module exports one or more of these exact uppercase names. The
application layer supplies implicit `HEAD` and `OPTIONS` behavior when their
explicit handlers are absent; the router itself records only functions that the
module exports.

## Route filesystem contract

Oxian recognizes regular files ending in `.ts`, `.js`, `.mts`, or `.mjs`. Files
are mapped as follows:

| Filesystem module      | URL pattern               |
| ---------------------- | ------------------------- |
| `index.ts`             | `/`                       |
| `users.ts`             | `/users`                  |
| `users/index.ts`       | `/users`                  |
| `users/[id].ts`        | `/users/:id`              |
| `assets/[...path].ts`  | `/assets/*path`           |
| `_middleware.ts`       | Middleware at `/`         |
| `users/_middleware.ts` | Middleware below `/users` |

Directory names use the same static, `[name]`, and `[...name]` segment syntax. A
catchall must be the final segment and captures one or more path segments; it
does not match an empty remainder.

Parameter names must be safe JavaScript identifiers matching
`[A-Za-z_][A-Za-z0-9_]*`. `__proto__`, `constructor`, and `prototype` are
reserved. A route may not repeat a parameter name.

Files whose basename starts with `_` are ignored except for `_middleware`.
Symlink files and directories are skipped. Two supported extensions may not
represent the same logical path, such as `users.ts` and `users.js`.

### Route modules

```ts
// routes/users/[id].ts
import type { RouteHandler } from "jsr:@oxian/oxian-js@0.21.0/router";

export const GET: RouteHandler<AppState> = (_request, context) =>
  Response.json({
    id: context.params.id,
    startedAt: context.state.startedAt,
  });

export const DELETE: RouteHandler<AppState> = async (
  _request,
  context,
) => {
  await deleteUser(String(context.params.id), context.signal);
  return new Response(null, { status: 204 });
};
```

A route module:

- must export at least one supported named HTTP method;
- must export a function for every supported method it names;
- may not export `default` or `all`;
- may not export another all-uppercase method-like name such as `CONNECT` or
  `TRACE`.

Other non-uppercase helper exports are permitted. Handler return values are
validated as native `Response` objects when the application executes them.

### Middleware modules

```ts
// routes/users/_middleware.ts
import type { RouteMiddleware } from "jsr:@oxian/oxian-js@0.21.0/router";

export const middleware: RouteMiddleware<AppState> = async (
  request,
  context,
  next,
) => {
  authorize(request, context.state);
  return await next();
};
```

Every discovered `_middleware` module must export a named `middleware` function.
For a selected route, compiled middleware is ordered from the routes root toward
the route's directory. Middleware onion execution and `next()` rules are
implemented by the `/app` subpath.

## `createFileRouter`

```ts
type CreateFileRouterOptions = Readonly<{
  root: string | URL;
}>;

function createFileRouter<State = unknown>(
  options: CreateFileRouterOptions,
): Promise<FileRouter<State>>;
```

`root` must be a filesystem path or `file:` URL. Relative paths resolve from the
current working directory. Other URL protocols throw `TypeError`.

```ts
import { createFileRouter } from "jsr:@oxian/oxian-js@0.21.0/router";

const router = await createFileRouter<AppState>({
  root: new URL("./routes/", import.meta.url),
});
```

Before resolving, the function recursively walks the root, imports every
recognized route and middleware module, validates the complete tree, orders the
routes, builds its matcher, and freezes the public snapshot. Filesystem,
permission, import, or module-evaluation failures reject the promise.

Startup validation also rejects:

- malformed, duplicate, or non-final parameters;
- duplicate canonical routes;
- structurally ambiguous routes, such as `/users/[id]` and `/users/[slug]`;
- extension collisions;
- invalid route export shapes;
- any invalid discovered middleware module.

No filesystem access or dynamic import occurs through `match` after
`createFileRouter` resolves.

## `FileRouter`

```ts
type FileRouter<State = unknown> = Readonly<{
  root: string;
  routes: readonly CompiledRoute<State>[];
  match(pathname: string): RouteMatch<State> | null;
}>;
```

- `root` is an absolute, trailing-slash-terminated `file:` URL string.
- `routes` is the frozen startup snapshot, sorted by pattern and then source
  URL.
- `match` is a pure, synchronous lookup. It returns `null` when no route
  matches.

Matching tries literal segments before a parameter and a parameter before a
catchall. This gives static routes precedence over dynamic ones regardless of
filesystem discovery order.

`match` ignores a query or fragment if one is present in its string, decodes
each path segment with `decodeURIComponent`, and ignores empty slash-separated
segments. Malformed percent encoding throws `URIError`. Normal application
dispatch passes `URL.pathname`, so callers usually provide a pathname only.

```ts
const match = router.match("/users/alice");

if (match !== null) {
  console.log(match.route.pattern); // "/users/:id"
  console.log(match.params.id); // "alice"
}
```

The match object and its params are newly frozen. The route and middleware
entries are shared immutable startup metadata.

## Handler and context types

```ts
type RouteHandler<State = unknown> = (
  request: Request,
  context: RouteContext<State>,
) => Response | Promise<Response>;

type RouteMiddleware<State = unknown> = (
  request: Request,
  context: RouteContext<State>,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

type RouteContext<State = unknown> = Readonly<{
  params: RouteParams;
  route: CompiledRoute<State>;
  signal: AbortSignal;
  state: State;
}>;

type RouteMethods<State = unknown> = Readonly<
  Partial<Record<HttpMethod, RouteHandler<State>>>
>;
```

`context.signal` combines request cancellation with application disposal when
the route runs through `Application.fetch`.

## Parameter and segment types

```ts
type RouteParamValue = string | readonly string[];

type RouteParams = Readonly<
  Record<string, RouteParamValue>
>;

type StaticRouteSegment = Readonly<{
  type: "static";
  value: string;
}>;

type ParamRouteSegment = Readonly<{
  type: "param";
  name: string;
}>;

type CatchallRouteSegment = Readonly<{
  type: "catchall";
  name: string;
}>;

type RouteSegment =
  | StaticRouteSegment
  | ParamRouteSegment
  | CatchallRouteSegment;
```

Static and single-segment parameters produce strings. A catchall produces a
frozen array of strings.

## Compiled metadata types

```ts
type CompiledRoute<State = unknown> = Readonly<{
  pattern: string;
  fileUrl: string;
  segments: readonly RouteSegment[];
  methods: RouteMethods<State>;
}>;

type CompiledMiddleware<State = unknown> = Readonly<{
  fileUrl: string;
  middleware: RouteMiddleware<State>;
}>;

type RouteMatch<State = unknown> = Readonly<{
  route: CompiledRoute<State>;
  params: RouteParams;
  middlewares: readonly CompiledMiddleware<State>[];
}>;
```

`CompiledRoute.pattern` uses `:name` for a parameter and `*name` for a catchall.
`fileUrl` values are immutable absolute module URL strings.

## Ownership notes

A `FileRouter` owns only an in-memory snapshot of imported module functions and
compiled match metadata. It does not watch the filesystem, reload modules, open
listeners, create application state, or own request lifecycle. Rebuild the
router to observe route-file changes.
