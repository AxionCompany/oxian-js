# Vision

**Guiding principle:** *Turn simple ESM into enterprise-grade APIs.*
**DX:** `deno -A jsr:@oxian/oxian-js` → runs your API directly from a local folder or a GitHub URL. No build step required for the happy path.

# 0) TL;DR of the dev model

* **Routes from files** (Next.js style).
* **ESM exports as handlers** (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`, `default`).
* **Two args** in handlers: `(data, context)`.
* **Dependencies**, **middlewares**, **interceptors** resolved per-folder, composed top-down.
* **Return** → 200 with body. **Throw** → error response. Or use `context.response.*`.
* **Request IDs**, structured logs, streaming supported.
* **Loaders** let you run from **local** or **GitHub**, more to come.

---

# 1) Config

**Files:** `oxian.config.json` **or** `oxian.config.ts|js` (TS/JS can export default).

**Schema (v0 draft):**

```ts
type OxianConfig = {
  root?: string; // default: process cwd
  basePath?: string; // e.g. "/api"
  loaders?: {
    local?: { enabled?: boolean };
    github?: { enabled?: boolean; tokenEnv?: string; cacheTtlSec?: number };
    // future: s3, gcs, gitlab...
  };
  runtime?: {
    hotReload?: boolean; // dev default: true
    watchGlobs?: string[]; // for dev
  };
  server?: {
    port?: number; // default: 8080
  };
  routing?: {
    trailingSlash?: "always" | "never" | "preserve";
    // conflicts resolution policy (see router section)
  };
  security?: {
    cors?: { allowedOrigins: string[]; allowedHeaders?: string[]; methods?: string[] };
    defaultHeaders?: Record<string,string>;
  };
  logging?: {
    level?: "debug" | "info" | "warn" | "error";
    requestIdHeader?: string; // if present, reuse; else generate
  };
};
```

**Precedence:** `oxian.config.*` > env > built-in defaults. JSON validated on boot; TS/JS evaluated ESM-style.

---

# 2) Routing (Next.js-like)

* **File roots:** `./routes` (default) or `{root}/routes`.
* **HTTP method binding:** named exports: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`. If missing, use `default` as fallback.
* **Path mapping:**

  * `/users.ts` → `/users`
  * `/users/[id].ts` → `/users/:id`
  * `/docs/[...slug].ts` (catch-all) → `/docs/*`
  * `/index.ts` → `/`
* **Conflicts:** Most specific wins (static > dynamic > catch-all). If tie, error at startup with diagnostics.
* **Coexistence:** Folder per route also allowed: `/users/[id]/index.ts` → `/users/:id`.

---

# 3) Handler contract

```ts
export async function GET(
  data: Record<string, unknown>, 
  context: Context
): Promise<unknown | void>;
```

**`data`** is the merged envelope:

```ts
// precedence: pathParams > query > body (body keys don't overwrite route keys)
type Data = {
  // all request params flattened
  [k: string]: unknown;
};
```

**`context`**:

```ts
type Context = {
  requestId: string;
  request: {
    method: string;
    url: string;
    headers: Headers;
    pathParams: Record<string,string>;
    queryParams: URLSearchParams; // plus parsed Record version
    body: unknown; // JSON by default, or raw if non-JSON
    raw: Request; // Deno Request
  };
  dependencies: Record<string, unknown>; // composed (see below)
  response: {
    send: (body: unknown, init?: Partial<{status:number; headers:Record<string,string>; statusText:string}>) => void;
    stream: (init?: Partial<{status:number; headers:Record<string,string>; statusText:string}>) => WritableStreamDefaultWriter | ((chunk:Uint8Array|string)=>void);
    status: (code: number) => void;
    headers: (headers: Record<string,string>) => void;
    statusText: (text: string) => void;
  };
  // room for framework internals:
  oxian: { route: string; startedAt: number };
};
```

**Return & throw semantics**

* **Return value** → 200 OK (or current `status()` if you set it) with auto JSON if object/array, text if string/Uint8Array; `Content-Type` inferred.
* **Throw**:

  * `throw new Error("msg")` → 500 unless an error interceptor overrides.
  * `throw { message, statusCode, statusText }` → exactly that (message serialized as JSON: `{ error: message }`).
  * **What if** you need typed errors? Reserve `OxianHttpError` class with `{code, status, details}`.

**Streaming**

* `context.response.stream()` returns a writer **and keeps the connection open**.

  * Use `writer.write(...)` then `writer.close()`.
  * If headers unset, framework sets `Transfer-Encoding: chunked` and `Content-Type: text/plain; charset=utf-8`.
  * For SSE later, we can expose `response.sse()`—future-friendly.

**Example route**

```ts
// routes/users/[id].ts
export async function GET({ id }, { dependencies, response }) {
  const { db } = dependencies;
  const user = await db.users.get(id);
  if (!user) throw { message: "Not found", statusCode: 404, statusText: "Not Found" };
  return user; // auto 200 application/json
}
```

---

# 4) Dependencies (composed per path)

**Files:** `dependencies.ts|js`.
**Shape:** default export is a function `(depsFromFramework) => Record<string, unknown>` or `Promise<...>`.

* **Where:** Any folder on the path to the matched route can include one.
  Example for `/org/[orgId]/users/[id]`:

  * `/routes/dependencies.ts`
  * `/routes/org/dependencies.ts`
  * `/routes/org/[orgId]/dependencies.ts`
  * `/routes/org/[orgId]/users/dependencies.ts`

* **Composition order:** root → … → leaf (later can **override** earlier keys unless `freeze` option is set in config later).

* **Invocation timing:** **Once per worker lifecycle per module graph** (first request “instantiation”), **not** per-request. Good for clients/pools.

```ts
// routes/org/[orgId]/dependencies.ts
export default async (fw) => {
  const db = await fw.makeDb({ schema: "org" });
  return { db };
};
```

**What if** you need request-scoped deps (e.g., auth claims)?
→ Put them into a **middleware** instead (next section), or later we add `dependencies.request.ts`.

---

# 5) Middlewares

**Files:** `middleware.ts|js`.
**Contract:** default export `(data, context) => Promise<{data?: any; context?: Partial<Context>}> | void`.

* **Run order:** root → … → leaf, **before** the endpoint.
* **Mutation:** You may return partial updates; framework shallow-merges `data` and deep-merges `context`.
* **Short-circuit:** Throw to block the request (e.g., auth).

```ts
// routes/middleware.ts
export default (data, context) => {
  // add correlation header for downstreams
  context.response.headers({ "x-request-id": context.requestId });
  return { context };
};
```

---

# 6) Interceptors

**Files:** `interceptors.ts|js`.
**Exports:**

```ts
export async function beforeRun(data, context) { /* return updates like middleware */ }
export async function afterRun(resultOrError, context) { /* result if fine, Error or thrown object if not */ }
```

* **Run order:** root → … → leaf **before middleware & endpoint**, and **leaf → … → root after the endpoint** (reverse on the way out).
* **Use cases:** metrics, tracing, audit logs, error shaping.

---

# 7) Response helpers (auto types)

* **Auto JSON** when an object is detected.
* `send(obj)` sets `Content-Type: application/json; charset=utf-8`.
* `send(string|Uint8Array)` sets `text/plain` or `application/octet-stream`.
* `headers()` merges with existing; duplicates overwrite.
* **Status text** default from standard list; overridable by `statusText()`.

---

# 8) Loader architecture (local + GitHub)

**Why:** We don’t use static `import`—we **dynamically load and bundle** the target ESM graph with Deno’s `emit.bundle`, using a **custom `load` hook**.

**Loader interface:**

```ts
type Loader = {
  scheme: "local" | "github"; // more later
  canHandle: (url: URL) => boolean;
  load: (url: URL) => Promise<{ content: string; mediaType: "ts"|"js"|"tsx"|"jsx"|"json" }>;
  listDir?: (url: URL) => Promise<string[]>; // needed for routing discovery
  stat?: (url: URL) => Promise<{ isFile: boolean; mtime?: number }>;
  cacheKey?: (url: URL) => string; // for memoization
};
```

**Local loader**

* `root` = cwd by default.
* Uses Deno `readFile`, `readDir`, `stat`.
* Watches files in dev for hot-reload (debounced).

**GitHub loader**

* Accepts URLs like `github:owner/repo/path?ref=main` or `https://github.com/owner/repo/...` (normalized).
* Uses GitHub API (raw content) with `Authorization: token ${GITHUB_TOKEN}` if provided.
* Basic caching (in-memory + optional disk) with `cacheTtlSec`.
* **Directory traversal** to build routes; respects `.oxianignore` (future).

**emit/bundle flow**

1. Resolve route file → URL.
2. `emit.bundle(entryUrl, { load })` where `load` consults active loader.
3. `dynamic import("data:application/javascript," + encodeURIComponent(bundle))`.
4. Keep module instance in an **LRU cache** (keyed by route + mtime/ref).

   * **Dev**: bust cache on file change.
   * **Prod**: cache until TTL or deployment refresh.

**What if** the repo is private or rate-limited?

* Clear error with `requestId`, hint to set `GITHUB_TOKEN`, and a retry-after.

---

# 9) Server & lifecycle

* **HTTP runtime:** Deno’s native `serve()` with AbortController support.
* **Per-request pipeline:**

  1. Build `requestId`.
  2. Parse URL → match route.
  3. Loader resolves module (or from cache).
  4. Compose **dependencies** (once) and memoize per module.
  5. Run **interceptors.beforeRun** (root→leaf).
  6. Run **middlewares** (root→leaf).
  7. Invoke **handler** for the HTTP method or **default**.
  8. If **return** → serialize & write. If **throw** → map to error response.
  9. Run **interceptors.afterRun** (leaf→root) with the result or error.
  10. Flush and close, unless **stream()** kept it open.
* **Graceful shutdown:** stop accepting, drain in-flight, close streams with final chunk.

---

# 10) Errors & observability

**Standard error shape:**

```json
{ "error": { "message": "Not found", "code": "NOT_FOUND", "details": {...} } }
```

* Map `{ message, statusCode, statusText }` automatically.
* Unknown errors → 500 with generic message; original message kept in logs (with `requestId`).
* **Logs:** structured JSON per request `{ requestId, route, method, status, durationMs }`.
* **What if** compliance wants no PII in logs? Add `security.scrubHeaders` list + a redactor.

---

# 11) CLI & entrypoint

* **Run:** `deno -A jsr:@oxian/oxian-js` (no args → local cwd).

  * `--source=github:owner/repo/path?ref=main`
  * `--port=8080`
  * `--config=oxian.config.ts`
* **Dev:** `oxian dev` alias with watch/hot-reload, pretty errors.
* **Start:** `oxian start` optimized (pre-bundle & warm routes).
* **Inspect:** `oxian routes` prints the resolved table.

---

# 12) Testing & examples

* **Contract tests:** minimal “hello world,” param route, catch-all, streaming, dependency composition, middleware order, interceptors before/after, GitHub loader.
* **E2E harness:** spins server on random port, runs fetches, asserts JSON/headers.

---

# 13) NFRs (first cut)

* **TTFU:** scaffold + first request in **≤ 2 minutes** (no build).
* **Cold route invoke (uncached bundle):** p95 **≤ 400ms** local; **≤ 900ms** via GitHub loader (with token).
* **Warm route invoke:** p95 **≤ 80ms** for lightweight handler.
* **Streaming latency to first byte:** **≤ 50ms** after handler calls `stream()`.
* **Concurrency:** 1k rps on a mid instance (target; adjust once measured).
* **Reliability:** Graceful shutdown; no partial writes unless streaming.

---

# 14) Minimal reference snippets

**Interceptors**

```ts
// routes/interceptors.ts
export async function beforeRun(data, { requestId, oxian }) {
  oxian.startedAt = performance.now();
}
export async function afterRun(resultOrErr, { requestId, oxian }) {
  const ok = !(resultOrErr instanceof Error) && !('statusCode' in (resultOrErr ?? {}));
  console.log(JSON.stringify({ requestId, ok, ms: performance.now() - oxian.startedAt }));
}
```

**Middleware (auth example)**

```ts
// routes/org/[orgId]/middleware.ts
export default (data, context) => {
  const auth = context.request.headers.get("authorization");
  if (!auth) throw { message: "Unauthorized", statusCode: 401, statusText: "Unauthorized" };
};
```

**Streaming**

```ts
export async function GET(_, { response }) {
  const write = response.stream({ headers: { "content-type": "text/plain" } });
  write("hello");
  await new Promise(r => setTimeout(r, 100));
  write("\nworld");
  // close:
  write(""); // no-op ok
}
```
