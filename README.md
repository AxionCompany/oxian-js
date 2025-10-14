# 🚀 Oxian

> **Turn simple ESM into enterprise-grade APIs**

Oxian is a modern, zero-build framework that lets you create powerful APIs
directly from TypeScript/JavaScript files. Run locally or from GitHub URLs in
seconds.

```bash
# Run instantly - no build step required!
deno -A jsr:@oxian/oxian-js
```

[![JSR](https://jsr.io/badges/@oxian/oxian-js)](https://jsr.io/@oxian/oxian-js)
[![Deno](https://img.shields.io/badge/deno-1.40+-green)](https://deno.land)

## ✨ Key Features

- 🗂️ **File-based routing** (Next.js style)
- 🔥 **Zero build step** - run TypeScript directly
- ⚡ **Hot reload** in development
- 🌊 **Streaming & SSE** support
- 🔍 **Request IDs** & OpenTelemetry (logs, metrics, traces)
- 🐙 **GitHub loader** - run APIs from any repo
- 🎯 **Type-safe** with full TypeScript support
- 🔧 **Middleware/Interceptor** composition system
- 🔧 **Dependency injection** - file-based dependency injection composition

## 🚀 Quick Start

### 1. Create your first route

```bash
mkdir my-api && cd my-api
mkdir routes
```

Create `routes/index.ts`:

```ts
export function GET() {
  return { message: "Hello, Oxian!" };
}

export function POST({ name }) {
  return { greeting: `Hello, ${name}!` };
}
```

### 2. Run your API

```bash
deno -A jsr:@oxian/oxian-js
```

Your API is now running at `http://localhost:8080`! 🎉

### 3. Test it

```bash
# GET request
curl http://localhost:8080
# {"message":"Hello, Oxian!"}

# POST request
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"World"}' http://localhost:8080
# {"greeting":"Hello, World!"}
```

## 🔧 Init command

Bootstrap a new Oxian project with sensible defaults and interactive prompts.

```bash
deno -A jsr:@oxian/oxian-js init
```

This will:

- Create/update `oxian.config.json` (asks for port, routesDir, logging level)
- Create/update `deno.json` with useful tasks
- Create/update `llm.txt` (local copy)

If any target file already exists, you will be prompted per file:

- [a]ppend: merge for JSON files; append content for text files
- [o]verwrite: replace the file with the generated content
- [c]ancel: skip that file

## 📁 File-Based Routing

Oxian uses intuitive file-based routing that maps directly to URL paths:

```
routes/
├── index.ts          → GET /
├── users.ts          → GET,POST /users  
├── users/
│   ├── [id].ts       → GET,POST /users/:id
│   └── settings.ts   → GET /users/settings
└── docs/
    └── [...slug].ts  → GET /docs/* (catch-all)
```

### Route Examples

**Static routes:**

```ts
// routes/users.ts
export function GET() {
  return { users: [] };
}

export function POST({ name, email }) {
  // Create user logic
  return { id: 1, name, email };
}
```

**Dynamic routes:**

```ts
// routes/users/[id].ts
export function GET({ id }) {
  return { user: { id, name: "John" } };
}
```

**Catch-all routes:**

```ts
// routes/docs/[...slug].ts
export function GET({ slug }) {
  // slug will be an array: /docs/api/v1 → ["api", "v1"]
  return { page: slug.join("/") };
}
```

## 🏗️ Handler Signature

Every route handler receives two arguments:

```ts
export async function GET(
  data: Record<string, unknown>, // Merged request data
  context: Context, // Request context & utilities
) {
  return { success: true };
}
```

### Data Object

The `data` object merges all request parameters:

```ts
// URL: /users/123?role=admin
// Body: {"name": "John"}
// → data = { id: "123", role: "admin", name: "John" }

export function PUT({ id, role, name }) {
  // Path params override query params override body
  return { updated: { id, role, name } };
}
```

### Request Body Parsing

Oxian parses request bodies based on `Content-Type` and merges them into `data`
(lowest priority), with query and path params overriding as shown above.

- **application/json**: Parsed JSON object. Empty body → `undefined`.
- **text/plain**: Raw string.
- **application/x-www-form-urlencoded**: Key/value object. Duplicate keys become
  arrays. Values are strings.
- **multipart/form-data**:
  - Text fields: strings; duplicate keys become arrays of strings.
  - File fields: objects with base64 content and metadata:
    ```ts
    type UploadedFile = {
      filename: string;
      contentType: string;
      size: number;
      base64: string; // file bytes encoded as base64
    };
    ```
  - If a file field appears multiple times, `data[field]` is an array of
    `UploadedFile`.

Example (multipart upload):

```bash
curl -X POST \
  -F "avatar=@./avatar.png" \
  -F "userId=123" \
  http://localhost:8080/upload
```

```ts
// routes/upload.ts
export function POST({ userId, avatar }) {
  // avatar is either UploadedFile or UploadedFile[] depending on how many files were sent
  const file = Array.isArray(avatar) ? avatar[0] : avatar;
  return {
    userId,
    filename: file?.filename,
    size: file?.size,
    preview: file?.base64?.slice(0, 24), // sample usage
  };
}
```

Note: The original unparsed request body bytes are available at
`context.request.rawBody` as a `Uint8Array`.

### Context Object

The `context` provides request details and response utilities:

```ts
export function GET(data, context) {
  const {
    requestId, // Unique request identifier
    request: { // Request details
      method,
      url,
      headers,
      pathParams, // { id: "123" }
      queryParams, // URLSearchParams object
      query, // Parsed query object
      body, // Parsed request body
      raw, // Original Request object
    },
    dependencies, // Injected dependencies
    response: { // Response utilities
      send, // Send response
      stream, // Streaming response
      sse, // Server-sent events
      status, // Set status code
      headers, // Set headers
      statusText, // Set status text
    },
    oxian: { // Framework internals
      route,
      startedAt,
    },
  } = context;

  return { requestId };
}
```

## 🔧 Dependencies

Inject shared services and utilities using `dependencies.ts` files:

```ts
// routes/dependencies.ts
export default async function () {
  const db = await createDatabase();
  const redis = await createRedisClient();

  return { db, redis };
}
```

Use in your routes:

```ts
// routes/users/[id].ts
export function GET({ id }, { dependencies }) {
  const { db } = dependencies;
  return db.users.findById(id);
}
```

### Dependency Composition

Dependencies compose down the folder tree:

```
routes/
├── dependencies.ts      → { db, logger }
└── api/
    ├── dependencies.ts  → { db, logger, auth } (inherits + adds)
    └── users/
        └── [id].ts      → Access all dependencies
```

## 🛠️ Middleware

Add request/response processing with `middleware.ts`:

```ts
// routes/middleware.ts
export default function (data, context) {
  // Add request ID to response headers
  context.response.headers({
    "x-request-id": context.requestId,
  });

  // Modify request data
  return {
    data: { ...data, timestamp: Date.now() },
  };
}
```

Middleware runs **before** your route handler and can:

- Modify request data
- Add response headers
- Throw errors to short-circuit (e.g., auth)

## 🎯 Interceptors

Add cross-cutting concerns with `interceptors.ts`:

```ts
// routes/interceptors.ts
export async function beforeRun(data, context) {
  // Start timing
  context.oxian.startedAt = performance.now();

  // Add correlation ID
  return {
    data: { ...data, correlationId: crypto.randomUUID() },
  };
}

export async function afterRun(resultOrError, context) {
  // Log request completion
  const duration = performance.now() - context.oxian.startedAt;
  console.log({
    requestId: context.requestId,
    route: context.oxian.route,
    duration,
    success: !(resultOrError instanceof Error),
  });
}
```

Interceptors wrap around the entire request lifecycle:

- `beforeRun`: Executes before middleware and handlers
- `afterRun`: Executes after handlers (success or error)

## 🌊 Streaming & SSE

### Streaming Responses

```ts
export async function GET(_, { response }) {
  // Start streaming
  response.stream({
    headers: { "content-type": "text/plain" },
  });

  response.stream("Hello ");
  await new Promise((r) => setTimeout(r, 1000));
  response.stream("World!");

  // Stream closes automatically when handler returns
}
```

### Server-Sent Events

```ts
export async function GET(_, { response }) {
  const sse = response.sse({ retry: 1000 });

  let count = 0;
  const interval = setInterval(() => {
    sse.send({ count: ++count }, { event: "update" });

    if (count >= 5) {
      clearInterval(interval);
      sse.close();
    }
  }, 1000);
}
```

## ⚙️ Configuration

Configure your app with `oxian.config.json`:

```json
{
  "server": {
    "port": 8080
  },
  "routing": {
    "routesDir": "routes",
    "trailingSlash": "preserve"
  },
  "runtime": {
    "hotReload": true
  },
  "security": {
    "cors": {
      "allowedOrigins": ["*"],
      "allowedHeaders": ["authorization", "content-type"]
    }
  },
  "logging": {
    "level": "info",
    "requestIdHeader": "x-request-id"
  }
}
```

Or use TypeScript for dynamic configuration:

```ts
// oxian.config.ts
export default {
  server: {
    port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
  },
  loaders: {
    github: {
      enabled: true,
      tokenEnv: "GITHUB_TOKEN",
    },
  },
};
```

## 🐙 GitHub Loader

Run APIs directly from GitHub repositories:

```bash
# Run from GitHub repo
deno -A jsr:@oxian/oxian-js --source=github:owner/repo/path?ref=main

# Or use GitHub URL
deno -A jsr:@oxian/oxian-js --source=https://github.com/owner/repo/tree/main/api
```

Perfect for:

- 🔄 **Rapid prototyping** - no git clone needed
- 📚 **Documentation examples** - live, runnable code
- 🎯 **Microservices** - deploy from any repo
- 🧪 **Testing** - run different versions/branches

### Private Repositories

Set your GitHub token for private repos:

```bash
export GITHUB_TOKEN=your_token_here
deno -A jsr:@oxian/oxian-js --source=github:private-org/private-repo
```

## 🛡️ Error Handling

### Throwing Errors

```ts
export function GET({ id }) {
  if (!id) {
    throw {
      message: "ID required",
      statusCode: 400,
      statusText: "Bad Request",
    };
  }

  // Or throw regular errors
  throw new Error("Something went wrong"); // → 500
}
```

### Using OxianHttpError

```ts
import { OxianHttpError } from "@oxian/oxian-js/types";

export function GET({ id }) {
  if (!id) {
    throw new OxianHttpError("ID required", {
      statusCode: 400,
      code: "MISSING_ID",
      details: { field: "id" },
    });
  }
}
```

### Global Error Handling

```ts
// routes/interceptors.ts
export async function afterRun(resultOrError, context) {
  if (resultOrError instanceof Error) {
    // Log error with context
    console.error({
      requestId: context.requestId,
      error: resultOrError.message,
      stack: resultOrError.stack,
    });
  }
}
```

## 📊 Response Utilities

### Manual Response Control

```ts
export function GET(_, { response }) {
  // Set status and headers
  response.status(201);
  response.headers({
    "location": "/users/123",
    "cache-control": "no-cache",
  });

  // Send response
  response.send({ created: true });
}
```

### Different Response Types

```ts
export function GET({ format }) {
  if (format === "xml") {
    return new Response("<data>Hello</data>", {
      headers: { "content-type": "application/xml" },
    });
  }

  if (format === "text") {
    return "Plain text response";
  }

  // Default JSON
  return { message: "JSON response" };
}
```

## 🔧 Development Tools

### CLI Commands

```bash
# Init command (bootstraps a new Oxian project with defaults and interactive prompts)
deno -A jsr:@oxian/oxian-js init

# Start development server (with hot reload)
deno -A jsr:@oxian/oxian-js dev

# Start production server
deno -A jsr:@oxian/oxian-js start

# List all routes
deno -A jsr:@oxian/oxian-js routes

# Help
deno -A jsr:@oxian/oxian-js --help
```

### Hot Reload

Files are automatically reloaded in development:

```bash
# Start with hot reload (default in dev)
deno -A jsr:@oxian/oxian-js dev
```

Changes to routes, dependencies, middleware, and interceptors trigger automatic
reloads.

## 🧩 Using with Vite (Frontend + Oxian)

Oxian works great alongside Vite. In development, run both servers and let Oxian
proxy non-API requests to Vite. In production, serve static files from Vite's
`dist/` as a fallback when a request doesn't match any API route.

### Dev setup

1. Run Vite on its default port (5173):

```bash
npm run dev
```

2. Run Oxian hypervisor on a different port (e.g., 8080) and configure a
   basePath for APIs, e.g., `/api`:

```json
// oxian.config.json
{
  "server": { "port": 8080 },
  "basePath": "/api",
  "routing": { "routesDir": "routes", "discovery": "lazy" },
  "runtime": {
    "hv": {
      "web": { "devProxyTarget": "http://localhost:5173" }
    }
  }
}
```

With this, requests that don't match an Oxian API route can be proxied to the
Vite dev server (configuration wiring described in docs). Your frontend fetches
can target `/api/...` to hit Oxian and everything else serves your Vite app.

### Production setup

Build your frontend and let Oxian serve static assets for non-API routes:

```bash
npm run build  # produces dist/
```

```json
// oxian.config.json
{
  "server": { "port": 8080 },
  "basePath": "/api",
  "runtime": {
    "hv": {
      "web": {
        "staticDir": "dist",
        "staticCacheControl": "public, max-age=31536000, immutable"
      }
    }
  }
}
```

Oxian will try API routes under `/api`; if no match, it serves files from
`dist/`. If a file is not found and no staticDir is configured, a 404 is
returned.

For more details and advanced options, see
[Using Oxian with Vite](./docs/integrations-vite.md).

### Per-project web configuration (multi-project)

In multi-project setups, you can overlay per-project web behavior over the
global `runtime.hv.web` settings. The hypervisor selects the project first (via
`hv.provider` or `hv.select`), determines the effective API base path (project
`routing.basePath` falling back to global), and for non-API requests applies the
per-project web config:

- `devProxyTarget`: Proxy non-API paths to a dev server (e.g., Vite)
- `staticDir`: Serve static files for non-API paths in production, with SPA
  `index.html` fallback
- `staticCacheControl`: Optional cache-control header for static assets

Example:

```json
{
  "server": { "port": 8080 },
  "basePath": "/api", // global default, can be overridden per project
  "runtime": {
    "hv": {
      "web": { "staticDir": "dist" },
      "projects": {
        "appA": {
          "routing": { "basePath": "/api" },
          "web": { "devProxyTarget": "http://localhost:5173" }
        },
        "appB": {
          "routing": { "basePath": "/b-api" },
          "web": {
            "staticDir": "apps/b/dist",
            "staticCacheControl": "public, max-age=3600"
          }
        }
      },
      "select": [
        { "project": "appA", "when": { "hostPrefix": "a." } },
        { "project": "appB", "when": { "hostPrefix": "b." } },
        { "default": true, "project": "appA" }
      ]
    }
  }
}
```

Behavior:

- Requests matching a project’s API base path are proxied to that project’s
  worker.
- Other paths are handled by that project’s `web` config (dev proxy if set;
  otherwise static serving if `staticDir` is set; otherwise 404).

### Request Transformation

Transform requests before they reach workers using the `onRequest` callback
(TypeScript config only):

```ts
// oxian.config.ts
export default {
  runtime: {
    hv: {
      onRequest: ({ req, project }) => {
        // Add custom headers, auth tokens, etc.
        const headers = new Headers(req.headers);
        headers.set("x-processed-by", "hypervisor");
        headers.set("x-project", project);
        return new Request(req, { headers });
      },
    },
  },
};
```

Use cases:

- Add authentication tokens to all requests
- Inject custom headers for downstream services
- Transform request URLs or bodies
- Implement request auditing/logging

### Worker idle shutdown

You can automatically stop idle workers to save resources. An idle worker is one
with no active requests/streams and no activity for a configured TTL. Long‑lived
streams and SSE are respected: the worker remains active until the client closes
the response body.

- Configure per project via `runtime.hv.projects[<name>].idleTtlMs` or at spawn
  time via provider/`SelectedProject.idleTtlMs`.
- Default is no TTL (workers do not auto‑stop unless configured).
- Precedence: provider → per‑project config → `runtime.hv.autoscale.idleTtlMs` →
  disabled when none provided.

Example:

```json
{
  "runtime": {
    "hv": {
      "autoscale": { "idleTtlMs": 300000 },
      "projects": {
        "api": { "idleTtlMs": 120000 }
      }
    }
  }
}
```

Behavior:

- Every proxied request marks activity; inflight count decrements only after the
  response body completes. Idle countdown starts after that.
- When `idleTtlMs` elapses with inflight=0, the worker is stopped. Next request
  spawns it on demand.

## 📝 TypeScript Support

Oxian is built with TypeScript-first design:

```ts
import type { Context, Data, Handler } from "@oxian/oxian-js/types";

interface User {
  id: string;
  name: string;
  email: string;
}

export const GET: Handler = async ({ id }: Data, { dependencies }: Context) => {
  const { db } = dependencies as { db: UserDatabase };
  const user: User = await db.findById(id);
  return user;
};
```

## 🎯 Best Practices

### 1. Structure Your Project

```
my-api/
├── oxian.config.json
├── routes/
│   ├── dependencies.ts     # Global dependencies
│   ├── middleware.ts       # Global middleware
│   ├── interceptors.ts     # Global interceptors
│   ├── index.ts           # Root route
│   ├── health.ts          # Health check
│   └── api/
│       ├── dependencies.ts # API-specific deps
│       ├── middleware.ts   # API auth/validation
│       ├── users/
│       │   ├── index.ts    # List users
│       │   └── [id].ts     # User by ID
│       └── posts/
│           ├── index.ts
│           └── [id]/
│               ├── index.ts
│               └── comments.ts
└── types/
    └── api.ts             # Shared types
```

### 2. Dependency Injection

```ts
// routes/dependencies.ts
export default async function () {
  const config = {
    database: {
      url: Deno.env.get("DATABASE_URL") || "sqlite:///tmp/db.sqlite",
    },
    redis: {
      url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
    },
  };

  const db = await createDatabase(config.database);
  const cache = await createRedisClient(config.redis);
  return { db, cache, config };
}
```

### 3. Authentication Middleware

```ts
// routes/api/middleware.ts
import { verify } from "https://deno.land/x/djwt/mod.ts";

export default async function (data, context) {
  const authHeader = context.request.headers.get("authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw {
      message: "Authentication required",
      statusCode: 401,
    };
  }

  const token = authHeader.slice(7);

  try {
    const payload = await verify(token, "your-secret-key", "HS256");
    return {
      context: {
        user: payload,
      },
    };
  } catch {
    throw {
      message: "Invalid token",
      statusCode: 401,
    };
  }
}
```

### 4. Input Validation

```ts
// routes/api/users/index.ts
export async function POST({ name, email }, { dependencies }) {
  // Validate input
  if (!name || typeof name !== "string") {
    throw {
      message: "Name is required",
      statusCode: 400,
      details: { field: "name" },
    };
  }

  if (!email || !email.includes("@")) {
    throw {
      message: "Valid email is required",
      statusCode: 400,
      details: { field: "email" },
    };
  }

  const { db } = dependencies;
  const user = await db.users.create({ name, email });

  return { user };
}
```

### 5. Request Logging

```ts
// routes/interceptors.ts
export async function beforeRun(data, context) {
  context.oxian.startedAt = performance.now();

  console.log(JSON.stringify({
    requestId: context.requestId,
    method: context.request.method,
    url: context.request.url,
    timestamp: new Date().toISOString(),
  }));
}

export async function afterRun(resultOrError, context) {
  const duration = performance.now() - context.oxian.startedAt;
  const isError = resultOrError instanceof Error;

  console.log(JSON.stringify({
    requestId: context.requestId,
    route: context.oxian.route,
    duration: Math.round(duration),
    status: isError ? "error" : "success",
    timestamp: new Date().toISOString(),
  }));
}
```

## 🚀 Deployment

### Docker Deployment

```dockerfile
FROM denoland/deno:alpine

WORKDIR /app
COPY . .

# Cache dependencies
RUN deno cache cli.ts

EXPOSE 8080
CMD ["deno", "run", "-A", "cli.ts"]
```

### Environment Variables

```bash
# Set production environment
export NODE_ENV=production
export PORT=8080
export DATABASE_URL=postgres://...
export REDIS_URL=redis://...

# Start server
deno -A jsr:@oxian/oxian-js --port=$PORT
```

### GitHub Actions

```yaml
name: Deploy API
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: denoland/setup-deno@v1
        with:
          deno-version: v1.40

      - name: Deploy
        run: |
          # Your deployment logic here
          deno run -A jsr:@oxian/oxian-js --source=github:${{ github.repository }}
```

## 🔍 Troubleshooting

### Common Issues

**Port already in use:**

```bash
# Use different port
deno -A jsr:@oxian/oxian-js --port=3000
```

**Module not found:**

```bash
# Clear Deno cache
deno cache --reload jsr:@oxian/oxian-js
```

**Permission denied:**

```bash
# Ensure all permissions
deno run --allow-all jsr:@oxian/oxian-js
```

**GitHub rate limiting:**

```bash
# Set GitHub token
export GITHUB_TOKEN=your_token
```

### Debug Mode

```bash
# Enable debug logging
OXIAN_LOG_LEVEL=debug deno -A jsr:@oxian/oxian-js

# Enable Deno OpenTelemetry auto-instrumentation (local dev)
OTEL_DENO=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 deno -A jsr:@oxian/oxian-js

## 📈 Instrumentation & Observability

Oxian uses Deno’s OpenTelemetry integration for traces, metrics, and logs. You can:
- Enable auto-instrumentation via config (`logging.otel.enabled`).
- Run a built-in OTLP HTTP collector in the hypervisor (`runtime.hv.otelCollector`).
- Add custom spans/metrics via `logging.otel.hooks` (onInit/onRequestStart/onRequestEnd).

See the full guide: [docs/instrumentation.md](./docs/instrumentation.md)
```

### Health Checks

```ts
// routes/health.ts
export function GET(_, { dependencies }) {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    dependencies: {
      database: dependencies.db ? "connected" : "disconnected",
    },
  };
}
```

## 🤖 Building MCP Servers

Oxian makes it easy to build **Model Context Protocol (MCP) servers** using streamable HTTP transport. MCP enables AI assistants to connect to external data sources and tools.

### Quick Example

```ts
// routes/mcp/dependencies.ts
import type { MCPServerConfig } from "@oxian/oxian-js/mcp";

export default function() {
  return {
    mcpServer: {
      info: { name: "my-mcp-server", version: "1.0.0" },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      tools: [{
        name: "get_data",
        description: "Fetch data from the database",
        inputSchema: { /* JSON Schema */ }
      }],
      resources: [],
      resourceTemplates: [],
      prompts: [],
      toolHandlers: {
        get_data: async (args) => ({ content: [{ type: "text", text: "..." }] })
      },
      readResource: (params) => ({ contents: [] }),
      getPrompt: (params) => ({ messages: [] })
    }
  };
}
```

```ts
// routes/mcp/index.ts
import { handleMCPRequest, handleMCPInfo } from "@oxian/oxian-js/mcp";

export async function POST(data, context) {
  const mcpConfig = context.dependencies.mcpServer;
  return await handleMCPRequest(data, context, mcpConfig);
}

export function GET(_data, context) {
  const mcpConfig = context.dependencies.mcpServer;
  return handleMCPInfo(mcpConfig);
}
```

**Full example**: See [`routes/mcp/`](./routes/mcp/) for a complete weather MCP server with tools, resources, and resource templates.

**Documentation**: [MCP Server Guide](./docs/mcp-server.md)

## 📚 Examples

Explore example routes included in this repo:

- **MCP Server**: `routes/mcp/` - Full MCP server with weather tools and resource templates
- Basic index route: `routes/index.ts`
- Dynamic params: `routes/users/[id].ts`
- SSE stream: `routes/sse.ts`
- Streaming response: `routes/stream.ts`
- DI composition: `routes/dep-compose/dependencies.ts` and
  `routes/dep-compose/leaf/index.ts`
- Middleware & interceptors: `routes/middleware.ts`, `routes/interceptors.ts`,
  `routes/users/middleware.ts`, `routes/order/a/interceptors.ts`
- Catch-all docs: `routes/docs/[...slug].ts`

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](./CONTRIBUTING.md) for
details.

### Development Setup

```bash
git clone https://github.com/oxian-org/oxian-js
cd oxian-js
deno test
```

## 📄 License

MIT License - see [LICENSE](./LICENSE) for details.

---

<div align="center">

**Built with ❤️ by the Oxian team**

[Website](https://oxiandigital.com/) • [Documentation](https://github.com/AxionCompany/oxian-js) •

</div>
