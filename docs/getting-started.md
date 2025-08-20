# 🚀 Getting Started with Oxian

This guide will help you create your first Oxian API in minutes and understand the core concepts.

## Prerequisites

- [Deno](https://deno.land) 1.40 or later
- Basic knowledge of TypeScript/JavaScript
- Familiarity with REST APIs

## Installation & First Run

Oxian requires no installation - run it directly from JSR:

```bash
# Create a new directory for your API
mkdir my-oxian-api && cd my-oxian-api

# Run Oxian (it will start with default settings)
deno run -A jsr:@oxian/oxian-js
```

This starts Oxian on `http://localhost:8080` with an empty routes directory.

## Your First Route

Let's create your first API endpoint:

### 1. Create the routes directory

```bash
mkdir routes
```

### 2. Create your first route

Create `routes/index.ts`:

```ts
export function GET() {
  return { 
    message: "Hello from Oxian!",
    timestamp: new Date().toISOString()
  };
}

export function POST({ name }) {
  if (!name) {
    throw { 
      message: "Name is required", 
      statusCode: 400 
    };
  }
  
  return { 
    greeting: `Hello, ${name}!`,
    received: new Date().toISOString()
  };
}
```

### 3. Start your server

```bash
deno run -A jsr:@oxian/oxian-js
```

You should see:
```
[cli] starting server { port: 8080, source: undefined }
```

### 4. Test your API

Open another terminal and test your endpoints:

```bash
# Test GET endpoint
curl http://localhost:8080
# Response: {"message":"Hello from Oxian!","timestamp":"2024-01-20T10:30:00.000Z"}

# Test POST endpoint
curl -X POST -H "Content-Type: application/json" \
  -d '{"name":"World"}' http://localhost:8080
# Response: {"greeting":"Hello, World!","received":"2024-01-20T10:30:00.000Z"}

# Test error handling
curl -X POST -H "Content-Type: application/json" \
  -d '{}' http://localhost:8080
# Response: {"error":{"message":"Name is required"}}
```

🎉 **Congratulations!** You've just created your first Oxian API!

## Development Mode

For development, use the `dev` command for hot reloading:

```bash
deno run -A jsr:@oxian/oxian-js dev
```

Now when you modify files, the server automatically reloads:

1. Edit `routes/index.ts` and change the message
2. Save the file
3. Test the endpoint again - changes are live immediately!

## Understanding the Basics

### File-Based Routing

Oxian uses file-based routing similar to Next.js:

```
routes/
├── index.ts          → GET,POST /
├── users.ts          → GET,POST /users
├── users/
│   ├── [id].ts       → GET,POST /users/:id
│   └── settings.ts   → GET /users/settings
└── health.ts         → GET /health
```

### HTTP Method Exports

Each route file exports functions named after HTTP methods:

```ts
// routes/users.ts
export function GET() {
  return { users: [] };
}

export function POST({ name, email }) {
  // Create user logic
  return { id: 1, name, email };
}

export function PUT({ id, ...updates }) {
  // Update user logic
  return { id, ...updates };
}

export function DELETE({ id }) {
  // Delete user logic
  return { deleted: true, id };
}
```

### Handler Parameters

Every handler receives two parameters:

```ts
export function GET(
  data,    // Merged request data (path params + query + body)
  context  // Request context and utilities
) {
  const { id } = data;                    // Path parameters
  const { requestId, response } = context; // Request context
  
  return { user: { id } };
}
```

## Next Steps

Now that you have a basic API running, explore these core concepts:

### 1. Dynamic Routes

Create `routes/users/[id].ts`:

```ts
export function GET({ id }) {
  return { 
    user: { 
      id, 
      name: `User ${id}`,
      email: `user${id}@example.com`
    }
  };
}
```

Test: `curl http://localhost:8080/users/123`

### 2. Query Parameters

Create `routes/search.ts`:

```ts
export function GET({ q, limit = 10 }) {
  return {
    query: q,
    limit: parseInt(limit),
    results: [`Result for "${q}"`]
  };
}
```

Test: `curl "http://localhost:8080/search?q=hello&limit=5"`

### 3. Request Body Handling

Create `routes/echo.ts`:

```ts
export function POST(data, { request }) {
  return {
    received: data,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries())
  };
}
```

Test: `curl -X POST -H "Content-Type: application/json" -d '{"test":"data"}' http://localhost:8080/echo`

### 4. Response Control

Create `routes/custom.ts`:

```ts
export function GET(_, { response }) {
  response.status(201);
  response.headers({
    "x-custom": "header",
    "cache-control": "no-cache"
  });
  
  return { created: true };
}
```

### 5. Error Handling

Create `routes/error-demo.ts`:

```ts
export function GET({ type }) {
  switch (type) {
    case "400":
      throw { 
        message: "Bad request demo", 
        statusCode: 400 
      };
    case "404":
      throw { 
        message: "Not found demo", 
        statusCode: 404,
        statusText: "Not Found"
      };
    case "500":
      throw new Error("Internal server error demo");
    default:
      return { error: "Use ?type=400|404|500 to test errors" };
  }
}
```

Test different error types:
- `curl http://localhost:8080/error-demo?type=400`
- `curl http://localhost:8080/error-demo?type=404`
- `curl http://localhost:8080/error-demo?type=500`

## Project Structure

Here's a typical Oxian project structure:

```
my-oxian-api/
├── oxian.config.json          # Configuration
├── routes/                    # API routes
│   ├── dependencies.ts        # Global dependencies
│   ├── middleware.ts          # Global middleware
│   ├── interceptors.ts        # Global interceptors
│   ├── index.ts              # Root route
│   ├── health.ts             # Health check
│   └── api/                  # API namespace
│       ├── dependencies.ts    # API-specific dependencies
│       ├── middleware.ts      # API-specific middleware
│       ├── users/
│       │   ├── index.ts       # GET,POST /api/users
│       │   └── [id].ts        # GET,PUT,DELETE /api/users/:id
│       └── posts/
│           ├── index.ts
│           └── [id]/
│               ├── index.ts
│               └── comments.ts
├── types/                     # Shared TypeScript types
│   └── api.ts
└── README.md
```

## Configuration

Create `oxian.config.json` for customization:

```json
{
  "server": {
    "port": 3000
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
      "allowedOrigins": ["http://localhost:3000"],
      "allowedHeaders": ["authorization", "content-type"]
    }
  },
  "logging": {
    "level": "info"
  }
}
```

Restart your server to apply changes:

```bash
deno run -A jsr:@oxian/oxian-js --port=3000
```

## Development Tips

### 1. Use TypeScript

Oxian is TypeScript-first. Import types for better DX:

```ts
import type { Context, Data } from "jsr:@oxian/oxian-js/types";

export function GET(data: Data, context: Context) {
  // Full TypeScript support with autocomplete
  return { requestId: context.requestId };
}
```

### 2. Check Routes

List all discovered routes:

```bash
deno run -A jsr:@oxian/oxian-js routes
```

### 3. Enable Debug Logging

```bash
OXIAN_LOG_LEVEL=debug deno run -A jsr:@oxian/oxian-js dev
```

### 4. Hot Reload Patterns

Oxian watches these file types for changes:
- `*.ts`, `*.js` - Route handlers
- `dependencies.ts` - Dependency injection
- `middleware.ts` - Middleware
- `interceptors.ts` - Interceptors
- `oxian.config.json` - Configuration

## What's Next?

Now that you understand the basics, dive deeper:

1. **[Routing](./routing.md)** - Master dynamic routes, catch-all patterns
2. **[Dependency Injection](./dependency-injection.md)** - Share services between routes
3. **[Middleware](./middleware.md)** - Add authentication, logging, validation
4. **[Streaming & SSE](./streaming-and-sse.md)** - Build real-time features
5. **[Deployment](./deployment.md)** - Deploy to production

## Common Issues

### Permission Denied

Make sure to use `-A` flag for all permissions:

```bash
deno run -A jsr:@oxian/oxian-js
```

### Port Already in Use

Use a different port:

```bash
deno run -A jsr:@oxian/oxian-js --port=3000
```

### Module Not Found

Clear Deno cache:

```bash
deno cache --reload jsr:@oxian/oxian-js
```

## Getting Help

- 📚 [Full Documentation](./README.md)
- 🐛 [Report Issues](https://github.com/oxian-org/oxian-js/issues)
- 💬 [Join Discord](https://discord.gg/oxian)
- 🤔 [Ask Questions](https://github.com/oxian-org/oxian-js/discussions)

---

Ready to build amazing APIs? Continue with our [routing guide](./routing.md) to learn about dynamic routes and advanced patterns! 🚀
