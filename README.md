# Oxian-js

Turn simple ES Modules into enterprise-grade APIs.


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

- You can export an object or a function. If a function is exported, it will receive the defaults and should return the config object (sync or async):

```ts
// oxian.config.ts
export default (defaults) => ({
  ...defaults,
  server: { port: 8080 },
  runtime: {
    ...defaults.runtime,
    dependencies: { initial: { feature: "from-fn" } },
  },
});
```

```ts
// oxian.config.ts (object form)
export default {
  root: Deno.cwd(),
  basePath: "/",
  loaders: {
    local: { enabled: true },
    github: { enabled: true, tokenEnv: "GITHUB_TOKEN", cacheTtlSec: 60 },
  },
  runtime: { 
    hotReload: true,
    // Inject base dependencies into every request context
    dependencies: {
      initial: { feature: "on" },                 // cheap constants (merged first)
      bootstrapModule: "./deps/bootstrap.ts",     // exports default/createDependencies(config)
      merge: "shallow",                           // current merge strategy
      readonly: ["feature"],                      // keys to freeze (Object.freeze)
    },
  }, 
  server: { port: 8080 },
  routing: {
    routesDir: "routes",
    trailingSlash: "preserve",
    discovery: "eager",
  },
  security: {
    cors: { allowedOrigins: ["*"], allowedHeaders: ["authorization", "content-type"], methods: ["GET","POST","PUT","DELETE","PATCH"] },
    defaultHeaders: { "x-powered-by": "oxian" },
    scrubHeaders: ["authorization", "cookie", "set-cookie"],
  },
  // Optional: declare permissions (enforced by future hypervisor/runtime profiles)
  permissions: {
    net: true,
    read: false,
    write: false,
    env: ["GITHUB_TOKEN"],
    ffi: false,
    hrtime: false,
    sys: false,
  },
  compatibility: {
    handlerMode: "default",
    allowShared: true,
  },
  logging: { level: "info", requestIdHeader: "x-request-id" },
} as const;
```

Precedence: `oxian.config.*` > env (`PORT`, `OXIAN_PORT`) > defaults.

### Dependency injection from config

- You can inject base dependencies via `runtime.dependencies`:
  - **initial**: plain object merged first (fast constants/flags)
  - **bootstrapModule**: module that exports `default` or `createDependencies(config)` returning an object; runs once per worker lifecycle (good for clients like DB/KV)
  - **merge**: current strategy is a shallow merge
  - **readonly**: array of keys frozen after composition
- Merge order at request time (later wins on key collisions):
  1. `runtime.dependencies.initial`
  2. `runtime.dependencies.bootstrapModule`
  3. Route `dependencies.ts` chain (root → … → leaf)
- Access in handlers via `context.dependencies`.

Example bootstrap module:

```ts
// deps/bootstrap.ts
export default async function createDependencies(config: unknown) {
  // e.g., connect to a database using env in config
  // const db = await connect(Deno.env.get("DB_URL"));
  return { helper: () => Date.now() };
}
```

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
- Base dependencies from `runtime.dependencies` are merged before route factories (see section above).

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
- `response.stream(init?)`: returns a write function `(chunk) => void` with `close()` and `done`.
  - Close with `write.close()` or by sending an empty string/empty Uint8Array (backward-compatible).
  - Auto-closes when the handler completes (resolves or throws), except for SSE.
  - Adds `cache-control: no-cache` and `x-accel-buffering: no` by default to discourage buffering by proxies.
- `response.sse(init?)`: sets SSE headers and returns `{ send, comment, close, done }`
  - `send(data, { event?, id?, retry? })` — formats and dispatches an SSE event
  - `comment(text)` — writes an SSE comment line
  - `close()` — closes the SSE stream
  - `done` — a Promise that resolves when the stream is closed

Streaming example:

```ts
export async function GET(_, { response }) {
  const write = response.stream({ headers: { "content-type": "text/plain" } });
  write("hello\n");
  await new Promise((r) => setTimeout(r, 50));
  write("world\n");
  // optional: non-SSE streams auto-close when the handler returns
}
```

SSE example:

```ts
export async function GET(_, { response }) {
  const sse = response.sse({ retry: 1000 });
  let i = 0;
  const id = setInterval(() => {
    i++;
    sse.send({ tick: i }, { event: "tick" });
    if (i >= 3) { clearInterval(id); sse.close(); }
  }, 1000);
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

- Structured JSON logs via `createLogger(level)`; deprecations can be toggled via `logging.deprecations` (default: true)
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

## Warmup (pre-bundle)

You can warm routes to pre-bundle modules and prime pipeline dependencies (eager routers):

```ts
import { warmup } from "./src/runtime/warmup.ts";
await warmup(config, source);
```

This is optional and can be added to a dedicated start path/command.

## Compatibility (deprecated)

For transitional use only. Configure in `compatibility` (deprecated; logs warnings):

- `handlerMode: "this"` — binds dependencies to `this` in handlers; handler signature is `(data, { response })`.
- `handlerMode: "factory"` — route module exports a factory receiving `dependencies` and returning `(data, { response }) => unknown`.
- `allowShared: true` — allows deprecated `shared.ts|js` alongside `dependencies.ts` with a deprecation warning.

See tests `tests/compat_mode_test.ts` for examples.

## Roadmap (near-term)

- Pre-bundle warmup and route cache (TTL)
- CLI: `oxian routes` as standalone binary, `dev` with pretty errors
- More loaders (S3, GCS, GitLab) and `.oxianignore`
- Examples and docs site

## License

MIT

## Hypervisor (optional)

Run multiple worker processes behind a lightweight proxy that preserves streaming and SSE.

- Enable via flag:
  ```sh
  deno run -A cli.ts --hypervisor
  ```
- Or in config:
  ```ts
  export default {
    runtime: { hv: { enabled: true, workers: "auto", strategy: "round_robin", workerBasePort: 9100, proxy: { timeoutMs: 30000, passRequestId: true } } },
  } as const;
  ```
- The proxy listens on `server.port` and spawns N workers on `workerBasePort..(base+N-1)`.
- Requests are distributed round-robin.
- Streaming/SSE are piped (no buffering), headers preserved.

### Scheduling strategies

- `round_robin` (default): simple even distribution
- `least_busy`: picks worker with lowest in-flight requests (tracked by proxy)
- `sticky`: pin requests to a worker using a header key (default `x-session-id`)
  ```ts
  export default {
    runtime: { hv: { enabled: true, strategy: "sticky", stickyHeader: "x-session-id" } },
  } as const;
  ```

### Autoscaling (in-flight based)

Configure automatic scale up/down per project pool:

```ts
export default {
  runtime: {
    hv: {
      enabled: true,
      autoscale: {
        enabled: true,
        min: 1,              // minimum workers per project (default: 1)
        max: 8,              // maximum workers per project (default: cpu count)
        targetInflightPerWorker: 16, // scale up if avg inflight > target
        maxAvgLatencyMs: 500,        // (reserved) optional latency trigger
        scaleUpCooldownMs: 5000,     // debounce scale up
        scaleDownCooldownMs: 10000,  // debounce scale down
        idleTtlMs: 2000,             // drain timeout on shutdown
      },
    },
  },
} as const;
```

- Scale-up: when average in-flight per worker exceeds `targetInflightPerWorker` (cooldown applies)
- Scale-down: when below ~50% of target for a while (cooldown applies)
- Drain: on shutdown, proxy waits up to `idleTtlMs` for in-flight requests to finish

### Per-project config via provider

Use a module provider to route requests and supply per-project config overrides:

```ts
// hv/provider.ts
export const pickProject = (req: Request) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith("/admin")) return { project: "admin", stripPathPrefix: "/admin" };
  return { project: "default" };
};

export const getProjectConfig = async (name: string) => {
  if (name === "admin") {
    return {
      // shallow config overrides written to a temp oxian.config.json for this pool
      config: {
        logging: { level: "info" },
        runtime: { dependencies: { initial: { feature: "admin" } } },
      },
      worker: { kind: "process", pool: { min: 1, max: 4 } },
    };
  }
  return { worker: { kind: "process", pool: { min: 1, max: 8 } } };
};

// Optional admission hook (throw to reject)
export const admission = async (req: Request, project: string) => {
  if (!req.headers.get("authorization")) {
    throw new Error("missing authorization");
  }
};
```

Run with provider:

```sh
deno run -A cli.ts --hypervisor --provider=module:./hv/provider.ts
```

Notes:
- Provider `pickProject(req)` decides the project and can set `stripPathPrefix` (e.g., `/admin` → `/`).
- Provider `getProjectConfig(name)` can return shallow config overrides and worker settings.
- Provider `admission(req, project)` can enforce quotas/rate limits/auth; respond 403 on error.

### Admin and metrics endpoints

The hypervisor exposes minimal control-plane endpoints (under the public port):

- `GET /_hv/status` — per-project worker list with `{ port, healthy, inflight, kind }`
- `GET /_hv/metrics` — basic per-project metrics `{ name, workers, inflight }`
- `POST /_hv/scaleUp?project=<name>` — adds one worker to the project pool
- `POST /_hv/scaleDown?project=<name>` — removes one worker from the project pool

These endpoints are unauthenticated by default; front them with your own auth layer or restrict network access in production.

### Experimental: thread workers (same-process)

Opt-in worker kind `thread` runs each project inside a Deno Web Worker (separate V8 isolate) to save memory versus processes.

- Enable per project via provider:
  ```ts
  export const getProjectConfig = () => ({ worker: { kind: "thread", pool: { min: 1, max: 4 } } });
  ```
- Permissions are applied to the worker via `permissions` in `oxian.config.*` (least privilege recommended):
  ```ts
  export default {
    permissions: {
      net: true,            // true | false | ["host:port", "localhost:*"]
      read: ["./routes"],  // limit filesystem reads
      write: false,
      env: [],
      ffi: false,
      hrtime: false,
    },
  } as const;
  ```
- Current status: experimental. For production, prefer `process` until thread mode is fully stabilized and benchmarked for your workload.

### Health checks and graceful shutdown

- Health: configure `runtime.hv.health = { path, intervalMs, timeoutMs }` (default HEAD `/` every 10s)
- Unhealthy/crashed workers are restarted automatically
- Shutdown: proxy drains in-flight requests up to `idleTtlMs` before terminating workers
