# 🛣️ Routing - File-Based API Routes

Oxian uses intuitive file-based routing that maps your file system structure directly to API endpoints. This approach, inspired by Next.js, makes your API structure predictable and easy to navigate.

## Basic Concepts

### File to Route Mapping

Your file structure directly maps to URL paths:

```
routes/
├── index.ts          → GET /
├── health.ts         → GET /health
├── users.ts          → GET,POST /users
└── posts.ts          → GET,POST /posts
```

### HTTP Method Exports

Each route file exports functions named after HTTP methods:

```ts
// routes/users.ts
export function GET() {
  return { users: [] };
}

export function POST({ name, email }) {
  return { id: 1, name, email };
}

export function PUT({ id, ...updates }) {
  return { id, ...updates };
}

export function DELETE({ id }) {
  return { deleted: true, id };
}

// Fallback for any method not explicitly handled
export default function({ method }) {
  throw { 
    message: `Method ${method} not allowed`, 
    statusCode: 405 
  };
}
```

## Dynamic Routes

### Path Parameters

Use `[parameter]` syntax for dynamic segments:

```
routes/
├── users/
│   ├── [id].ts       → /users/:id
│   └── [id]/
│       ├── index.ts  → /users/:id
│       ├── posts.ts  → /users/:id/posts
│       └── [postId].ts → /users/:id/:postId
```

**Example: User by ID**

```ts
// routes/users/[id].ts
export function GET({ id }) {
  return {
    user: {
      id,
      name: `User ${id}`,
      email: `user${id}@example.com`
    }
  };
}

export function PUT({ id, name, email }) {
  // Update user logic
  return { id, name, email, updated: true };
}

export function DELETE({ id }) {
  // Delete user logic
  return { deleted: true, id };
}
```

**Test:**
```bash
curl http://localhost:8080/users/123
curl -X PUT -H "Content-Type: application/json" \
  -d '{"name":"John","email":"john@example.com"}' \
  http://localhost:8080/users/123
curl -X DELETE http://localhost:8080/users/123
```

### Nested Dynamic Routes

```ts
// routes/users/[id]/posts/[postId].ts
export function GET({ id, postId }) {
  return {
    user: { id },
    post: { id: postId, title: `Post ${postId}` }
  };
}
```

**Test:**
```bash
curl http://localhost:8080/users/123/posts/456
```

## Catch-All Routes

### Basic Catch-All

Use `[...param]` to catch multiple path segments:

```
routes/
└── docs/
    └── [...slug].ts  → /docs/* (any depth)
```

```ts
// routes/docs/[...slug].ts
export function GET({ slug }) {
  // slug is an array of path segments
  // /docs/api/v1/users → slug = ["api", "v1", "users"]
  
  return {
    page: slug.join("/"),
    segments: slug,
    breadcrumbs: slug.map((segment, index) => ({
      name: segment,
      path: `/docs/${slug.slice(0, index + 1).join("/")}`
    }))
  };
}
```

**Test:**
```bash
curl http://localhost:8080/docs/api/v1/users
# Response: {
#   "page": "api/v1/users",
#   "segments": ["api", "v1", "users"],
#   "breadcrumbs": [...]
# }
```

### Optional Catch-All

Use `[[...param]]` for optional catch-all (matches both `/docs` and `/docs/anything`):

```ts
// routes/docs/[[...slug]].ts
export function GET({ slug = [] }) {
  if (slug.length === 0) {
    return { page: "index", title: "Documentation Home" };
  }
  
  return { page: slug.join("/"), segments: slug };
}
```

## Route Priority

When multiple routes could match a URL, Oxian follows this priority order:

1. **Static routes** - Exact file matches
2. **Dynamic routes** - `[param]` routes
3. **Catch-all routes** - `[...param]` routes

```
routes/
├── users.ts              # 1. Static: /users
├── users/
│   ├── settings.ts       # 1. Static: /users/settings
│   ├── [id].ts          # 2. Dynamic: /users/:id
│   └── [...path].ts     # 3. Catch-all: /users/*
```

**Resolution examples:**
- `/users` → `users.ts`
- `/users/settings` → `users/settings.ts`
- `/users/123` → `users/[id].ts`
- `/users/123/anything/else` → `users/[...path].ts`

## Folder vs File Routes

You can use either approach:

### File-based Routes

```
routes/
├── users.ts          → /users
└── posts.ts          → /posts
```

### Folder-based Routes

```
routes/
├── users/
│   └── index.ts      → /users
└── posts/
    └── index.ts      → /posts
```

### Mixed Approach

```
routes/
├── users.ts          → /users (list users)
└── users/
    ├── [id].ts       → /users/:id (user by ID)
    └── create.ts     → /users/create (create form)
```

## Query Parameters

Query parameters are automatically parsed and merged into the `data` object:

```ts
// routes/search.ts
export function GET({ q, limit = 10, sort = "created" }) {
  return {
    query: q,
    limit: parseInt(limit),
    sort,
    results: [`Results for "${q}"`]
  };
}
```

**Test:**
```bash
curl "http://localhost:8080/search?q=hello&limit=5&sort=updated"
```

### Array Query Parameters

Handle multiple values for the same parameter:

```ts
// routes/filter.ts
export function GET(data, { request }) {
  // URL: /filter?tags=js&tags=web&tags=api
  const tags = request.queryParams.getAll("tags");
  
  return {
    tags,
    count: tags.length
  };
}
```

## Request Body Handling

Request bodies are automatically parsed and merged:

```ts
// routes/users.ts
export function POST({ name, email, age }) {
  // Validate
  if (!name || !email) {
    throw { 
      message: "Name and email required", 
      statusCode: 400 
    };
  }
  
  // Create user
  return {
    id: Math.random().toString(36),
    name,
    email,
    age: age ? parseInt(age) : null,
    created: new Date().toISOString()
  };
}
```

**Test:**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"John","email":"john@example.com","age":"25"}' \
  http://localhost:8080/users
```

## Parameter Precedence

When the same parameter exists in multiple places, Oxian follows this precedence:

1. **Path parameters** (highest priority)
2. **Query parameters**
3. **Body parameters** (lowest priority)

```ts
// routes/users/[id].ts
export function PUT({ id, name }) {
  // URL: /users/123?id=456
  // Body: {"id": 789, "name": "John"}
  
  // id = "123" (from path, highest priority)
  // name = "John" (from body)
  
  return { id, name };
}
```

## Route Groups & Organization

### API Versioning

```
routes/
├── v1/
│   ├── users.ts      → /v1/users
│   └── posts.ts      → /v1/posts
└── v2/
    ├── users.ts      → /v2/users
    └── posts.ts      → /v2/posts
```

### Feature-based Organization

```
routes/
├── auth/
│   ├── login.ts      → /auth/login
│   ├── logout.ts     → /auth/logout
│   └── register.ts   → /auth/register
├── admin/
│   ├── users.ts      → /admin/users
│   └── reports.ts    → /admin/reports
└── api/
    ├── users.ts      → /api/users
    └── posts.ts      → /api/posts
```

### Public vs Protected Routes

```
routes/
├── public/
│   ├── health.ts     → /public/health
│   └── docs.ts       → /public/docs
└── protected/
    ├── middleware.ts  # Auth middleware
    ├── profile.ts    → /protected/profile
    └── settings.ts   → /protected/settings
```

## Advanced Routing Patterns

### Content Negotiation

Handle different response formats:

```ts
// routes/users/[id].ts
export function GET({ id, format }, { request }) {
  const user = { id, name: `User ${id}` };
  
  const acceptHeader = request.headers.get("accept");
  const formatParam = format || "json";
  
  if (formatParam === "xml" || acceptHeader?.includes("application/xml")) {
    return new Response(
      `<user><id>${user.id}</id><name>${user.name}</name></user>`,
      { headers: { "content-type": "application/xml" } }
    );
  }
  
  return user; // Default JSON
}
```

**Test:**
```bash
curl http://localhost:8080/users/123?format=xml
curl -H "Accept: application/xml" http://localhost:8080/users/123
```

### Method Override

Support method override for clients that can't send all HTTP methods:

```ts
// routes/users/[id].ts
export function POST({ id, _method, ...data }, { request }) {
  const method = _method || request.method;
  
  switch (method.toUpperCase()) {
    case "PUT":
      return updateUser(id, data);
    case "DELETE":
      return deleteUser(id);
    default:
      return createUser(data);
  }
}
```

**Test:**
```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"_method":"PUT","name":"John"}' \
  http://localhost:8080/users/123
```

### Conditional Routes

Route based on conditions:

```ts
// routes/api/[version]/users.ts
export function GET({ version }) {
  if (version === "v1") {
    return { users: [], version: "v1", deprecated: true };
  }
  
  if (version === "v2") {
    return { users: [], version: "v2", features: ["pagination"] };
  }
  
  throw { 
    message: `API version ${version} not supported`, 
    statusCode: 404 
  };
}
```

## Route Discovery

### List All Routes

```bash
deno run -A jsr:@oxian/oxian-js routes
```

Output:
```
Routes:
  GET /
  GET,POST /users
  GET,PUT,DELETE /users/:id
  GET /users/:id/posts
  GET /docs/*
  GET /health
```

### Route Validation

Oxian validates routes at startup and reports conflicts:

```
Error: Route conflict detected
  Static route: /users/settings.ts
  Dynamic route: /users/[id].ts
  
  For URL /users/settings, both routes match.
  Resolution: Static routes have priority.
```

## Configuration

### Custom Routes Directory

```json
{
  "routing": {
    "routesDir": "src/api",
    "trailingSlash": "never"
  }
}
```

### Trailing Slash Handling

```json
{
  "routing": {
    "trailingSlash": "always"   // /users → /users/
    "trailingSlash": "never"    // /users/ → /users  
    "trailingSlash": "preserve" // Keep as-is (default)
  }
}
```

### Route Discovery

```json
{
  "routing": {
    "discovery": "eager",    // Discover all routes at startup (default)
    "discovery": "lazy"      // Discover routes on first request
  }
}
```

## Best Practices

### ✅ Do

- Use descriptive file names (`users.ts`, not `u.ts`)
- Group related routes in folders
- Use consistent parameter naming
- Handle edge cases (missing parameters, invalid IDs)
- Validate input data
- Return consistent response formats

### ❌ Don't

- Create overly deep nesting (`/api/v1/users/123/posts/456/comments/789`)
- Use special characters in file names
- Mix different parameter styles in one project
- Ignore route conflicts
- Forget to handle HTTP methods you don't support

## Examples

### RESTful API

```
routes/
├── users.ts              # GET,POST /users
├── users/
│   ├── [id].ts          # GET,PUT,DELETE /users/:id
│   └── [id]/
│       ├── posts.ts     # GET,POST /users/:id/posts
│       └── posts/
│           └── [postId].ts # GET,PUT,DELETE /users/:id/posts/:postId
```

### Blog API

```
routes/
├── posts.ts              # GET,POST /posts
├── posts/
│   ├── [slug].ts        # GET /posts/:slug
│   ├── [id]/
│   │   ├── index.ts     # GET,PUT,DELETE /posts/:id
│   │   ├── comments.ts  # GET,POST /posts/:id/comments
│   │   └── publish.ts   # POST /posts/:id/publish
│   └── drafts.ts        # GET /posts/drafts
```

### Documentation Site

```
routes/
├── docs/
│   ├── [...slug].ts     # GET /docs/* (markdown pages)
│   └── search.ts        # GET /docs/search
├── api/
│   └── [...path].ts     # GET /api/* (API docs)
└── examples/
    └── [example].ts     # GET /examples/:example
```

---

File-based routing makes your API structure intuitive and maintainable. Start with simple static routes and gradually add dynamic patterns as your application grows.

**Next Steps:**
- [Handlers Guide](./handlers.md) - Master handler functions
- [Middleware](./middleware.md) - Add request processing
- [Dependency Injection](./dependency-injection.md) - Share services between routes
