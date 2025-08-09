# Oxian (Deno/TypeScript)

Turn simple ESM into enterprise-grade APIs. This repo contains the v0 scaffold for Oxian on Deno/TS with file-based routing, middlewares, interceptors, dependency composition, and dynamic loaders.

## Quickstart

- Requires: Deno 2.x

Run locally (from this repo root):

```sh
deno run -A cli.ts
```

Dev mode (watches and hot-clears module cache):

```sh
deno run -A cli.ts dev --port=8081
```

Print routes:

```sh
deno run -A cli.ts routes
```

Run contract tests:

```sh
deno test -A tests/contract_test.ts
```

## CLI

- `start` (default): start HTTP server
- `routes`: print resolved routes
- `dev`: start in watch mode (hot-reload via cache clear)

Flags:
- `--port=<number>`: override port (default 8080)
- `--config=<path>`: choose `oxian.config.*`
- `--source=<url>`: a source root (local or remote) to run

Examples:

```sh
# Start on a custom port
deno run -A cli.ts --port=9000

# Print routes from a GitHub source (future remote run)
deno run -A cli.ts routes --source=github:owner/repo/examples?ref=main
```

## Configuration

Oxian looks for `oxian.config.json|ts|js` in the working directory.

Schema (v0 draft):

```ts
// oxian.config.ts
export default {
  root: Deno.cwd(),
  basePath: "/",
  loaders: {
    local: { enabled: true },
    github: { enabled: true, tokenEnv: "GITHUB_TOKEN", cacheTtlSec: 60 },
  },
  runtime: { hotReload: true },
  server: { port: 8080 },
  routing: { trailingSlash: "preserve" },
  security: {
    cors: { allowedOrigins: ["*"] },
    defaultHeaders: { "x-powered-by": "oxian" },
    scrubHeaders: ["authorization", "cookie"],
  },
  logging: { level: "info", requestIdHeader: "x-request-id" },
} as const;
```

Precedence: `oxian.config.*` > env (`PORT`, `OXIAN_PORT`) > defaults.

## File-based routing

- Routes live under `routes/`.
- Mapping examples:
  - `routes/index.ts` → `/`
  - `routes/users.ts` → `/users`
  - `routes/users/[id].ts` → `/users/:id`
  - `routes/docs/[...slug].ts` → catch-all → `/docs/*`
  - Folder-style is supported: `routes/users/[id]/index.ts` → `/users/:id`
- Specificity: static > param > catch-all.

## Handlers

A route module can export HTTP method handlers or a `default` fallback:

```ts
export async function GET(data: Record<string, unknown>, context: Context) {
  return { ok: true };
}
```

Where `Context` includes:
- `requestId`: string
- `request`: method, url, headers, pathParams, queryParams (+record), body, raw
- `dependencies`: composed dependencies (see below)
- `response`: helpers (`send`, `stream`, `status`, `headers`, `statusText`)
- `oxian`: internal metadata `{ route, startedAt }`

Return semantics:
- Returning an object/array → `application/json` auto-serialize
- Returning string/Uint8Array → `text/plain`/`application/octet-stream`
- Use `response.send(...)` to override; use `response.stream(...)` for streaming
- Throw `{ message, statusCode, statusText }` to shape error responses

## Dependencies (composition)

- Any directory on the path to a route can define `dependencies.ts` exporting a default factory:

```ts
// routes/dependencies.ts
export default async (fw) => ({ db: createDb() });
```

- Composition order: root → … → leaf. Later (leaf) keys override earlier.
- Factories are evaluated once per worker lifecycle and memoized.

## Middlewares

- File: `middleware.ts` in any directory on the path
- Contract:

```ts
export default async function (data, context) {
  // mutate data/context by returning partials
  return { data: { ...data, userId: "123" }, context };
}
```

- Run order: root → … → leaf, before the handler
- Throw to short-circuit (e.g., auth)

## Interceptors

- File: `interceptors.ts` in any directory on the path
- Exports:

```ts
export async function beforeRun(data, context) { /* return updates like middleware */ }
export async function afterRun(resultOrError, context) { /* run after handler */ }
```

- Order: beforeRun runs root → … → leaf, afterRun runs leaf → … → root
- Use cases: metrics, tracing, audit logs, error shaping

## Response helpers

- `response.send(body, init?)`: sends explicit body and optional status/headers/statusText
- `response.status(code)`, `response.headers(map)`, `response.statusText(text)`
- `response.stream(init?)`: returns a write function `(chunk) => void`; call with `""` to close

Streaming example:

```ts
export async function GET(_, { response }) {
  const write = response.stream({ headers: { "content-type": "text/plain" } });
  write("hello");
  await new Promise((r) => setTimeout(r, 50));
  write(" world");
  write(""); // closes
}
```

## Loaders and remote sources

- Local loader: reads from the filesystem (default)
- GitHub loader: supports `github:owner/repo/path?ref=main` and `https://github.com/owner/repo/...`
  - Uses `raw.githubusercontent.com`, optional `GITHUB_TOKEN` (set via config `tokenEnv`)
- HTTP loader: resolves remote deps used by bundling
- Bundling: non-file routes are bundled via Deno's `emit` bundler with a custom loader hook

Note: remote execution wiring is in place, but the default CLI run targets the local `routes/` directory. Remote run will use the remote router and bundler.

## Logging

- Structured JSON logs via `createLogger(level)`
- Per-request logs include `{ requestId, route, method, status, durationMs }`
- Redaction: configure `security.scrubHeaders` (e.g., `authorization`, `cookie`)

## Security & headers

- CORS: set `security.cors.{allowedOrigins, allowedHeaders, methods}`
- Default headers: `security.defaultHeaders` merged into every response
- Request ID reuse: if `logging.requestIdHeader` is set and present in the request, it will be reused

## Testing

Contract tests are in `tests/contract_test.ts` and can be executed with:

```sh
deno test -A tests/contract_test.ts
```

Covered scenarios:
- Root hello world
- Param route unauthorized → authorized
- Trailing slash behavior
- Streaming
- Catch-all routing
- Interceptors order (before/after)
- Dependency composition override
- Error mapping via `{ statusCode }`

## Roadmap (near-term)

- Pre-bundle warmup and route cache (TTL)
- CLI: `oxian routes` as standalone binary, `dev` with pretty errors
- SSE helper and graceful shutdown hooks
- More loaders (S3, GCS, GitLab) and `.oxianignore`
- Examples and docs site

## License

MIT