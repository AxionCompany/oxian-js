# 🛠️ Middleware - Request & Response Processing

Middleware in Oxian provides a powerful way to process requests and responses before they reach your route handlers. Middleware is file-based, hierarchical, and composable, allowing you to build sophisticated request processing pipelines.

## Overview

Middleware in Oxian:

- **📁 File-based** - Defined in `middleware.ts` files
- **🌳 Hierarchical** - Executes from root to leaf
- **🔄 Composable** - Can modify request data and context
- **⚡ Async-friendly** - Supports Promise-based operations
- **🛡️ Security-focused** - Perfect for authentication, validation, and headers

```
routes/
├── middleware.ts          # Global middleware (runs first)
├── index.ts              # Route handler
└── api/
    ├── middleware.ts      # API middleware (runs second)
    ├── users.ts          # Route handler
    └── admin/
        ├── middleware.ts  # Admin middleware (runs third)
        └── users.ts      # Route handler
```

## Basic Middleware

### Creating Middleware

Create a `middleware.ts` file in any folder:

```ts
// routes/middleware.ts
import type { Data, Context } from "jsr:@oxian/oxian-js/types";

export default function(data: Data, context: Context) {
  // Add request ID to response headers
  context.response.headers({
    "x-request-id": context.requestId
  });
  
  // Add timestamp to request data
  return {
    data: {
      ...data,
      requestTimestamp: Date.now()
    }
  };
}
```

### Middleware Signature

Middleware functions receive the same arguments as route handlers:

```ts
export default function(
  data: Data,      // Request data (params + query + body)
  context: Context // Request context and utilities
) {
  // Process request
  
  // Return modifications (optional)
  return {
    data?: Data,                    // Modified request data
    context?: Partial<Context>      // Modified context
  };
}
```

### Async Middleware

Middleware can be asynchronous:

```ts
// routes/middleware.ts
export default async function(data, context) {
  // Async operations
  const userAgent = context.request.headers.get("user-agent");
  const geoLocation = await getGeoLocation(context.request);
  
  return {
    data: {
      ...data,
      userAgent,
      geoLocation
    }
  };
}
```

## Authentication Middleware

### JWT Authentication

```ts
// routes/api/middleware.ts
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

export default async function(data, context) {
  const authHeader = context.request.headers.get("authorization");
  
  if (!authHeader?.startsWith("Bearer ")) {
    throw {
      message: "Authentication required",
      statusCode: 401,
      statusText: "Unauthorized"
    };
  }
  
  const token = authHeader.slice(7);
  
  try {
    const secret = Deno.env.get("JWT_SECRET") || "development-secret";
    const payload = await verify(token, secret, "HS256");
    
    // Add user to context
    return {
      context: {
        user: payload
      }
    };
  } catch (error) {
    throw {
      message: "Invalid token",
      statusCode: 401,
      statusText: "Unauthorized"
    };
  }
}
```

### API Key Authentication

```ts
// routes/api/middleware.ts
export default async function(data, context, { dependencies }) {
  const { auth } = dependencies;
  const apiKey = context.request.headers.get("x-api-key");
  
  if (!apiKey) {
    throw {
      message: "API key required",
      statusCode: 401
    };
  }
  
  const user = await auth.validateApiKey(apiKey);
  if (!user) {
    throw {
      message: "Invalid API key",
      statusCode: 401
    };
  }
  
  return {
    data: { ...data, apiKey },
    context: { user }
  };
}
```

### Role-based Access Control

```ts
// routes/admin/middleware.ts
export default function(data, context) {
  const { user } = context;
  
  if (!user) {
    throw {
      message: "Authentication required",
      statusCode: 401
    };
  }
  
  if (!user.roles?.includes("admin")) {
    throw {
      message: "Admin access required",
      statusCode: 403,
      statusText: "Forbidden"
    };
  }
  
  // User is authenticated and has admin role
  return {};
}
```

## Validation Middleware

### Request Validation

```ts
// routes/api/users/middleware.ts
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().min(0).max(150).optional()
});

const UpdateUserSchema = CreateUserSchema.partial();

export default function(data, context) {
  const { method } = context.request;
  
  try {
    if (method === "POST") {
      // Validate create user data
      const validatedData = CreateUserSchema.parse(data);
      return { data: validatedData };
    }
    
    if (method === "PUT" || method === "PATCH") {
      // Validate update user data
      const validatedData = UpdateUserSchema.parse(data);
      return { data: validatedData };
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw {
        message: "Validation failed",
        statusCode: 400,
        details: error.errors
      };
    }
    throw error;
  }
  
  return {};
}
```

### Query Parameter Validation

```ts
// routes/api/middleware.ts
export default function(data, context) {
  const { method, queryParams } = context.request;
  
  if (method === "GET") {
    // Validate pagination parameters
    const page = queryParams.get("page");
    const limit = queryParams.get("limit");
    
    const validatedQuery = {
      page: page ? Math.max(1, parseInt(page)) : 1,
      limit: limit ? Math.min(100, Math.max(1, parseInt(limit))) : 20
    };
    
    return {
      data: {
        ...data,
        pagination: validatedQuery
      }
    };
  }
  
  return {};
}
```

## Request Processing Middleware

### Request Logging

```ts
// routes/middleware.ts
export default function(data, context) {
  const { method, url } = context.request;
  const { requestId } = context;
  
  console.log(JSON.stringify({
    type: "request_start",
    requestId,
    method,
    url,
    timestamp: new Date().toISOString(),
    userAgent: context.request.headers.get("user-agent")
  }));
  
  // Add request start time for duration calculation
  return {
    context: {
      oxian: {
        ...context.oxian,
        startTime: performance.now()
      }
    }
  };
}
```

### Rate Limiting

```ts
// routes/api/middleware.ts
const rateLimits = new Map();

export default function(data, context) {
  const clientIp = context.request.headers.get("x-forwarded-for") || 
                   context.request.headers.get("x-real-ip") || 
                   "unknown";
  
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  const maxRequests = 100;
  
  if (!rateLimits.has(clientIp)) {
    rateLimits.set(clientIp, { count: 1, resetTime: now + windowMs });
    return {};
  }
  
  const limit = rateLimits.get(clientIp);
  
  if (now > limit.resetTime) {
    // Reset window
    limit.count = 1;
    limit.resetTime = now + windowMs;
  } else {
    limit.count++;
  }
  
  if (limit.count > maxRequests) {
    throw {
      message: "Rate limit exceeded",
      statusCode: 429,
      statusText: "Too Many Requests",
      headers: {
        "retry-after": Math.ceil((limit.resetTime - now) / 1000).toString()
      }
    };
  }
  
  // Add rate limit info to response headers
  context.response.headers({
    "x-ratelimit-limit": maxRequests.toString(),
    "x-ratelimit-remaining": (maxRequests - limit.count).toString(),
    "x-ratelimit-reset": limit.resetTime.toString()
  });
  
  return {};
}
```

### Request Size Limiting

```ts
// routes/api/middleware.ts
export default async function(data, context) {
  const contentLength = context.request.headers.get("content-length");
  const maxSize = 10 * 1024 * 1024; // 10MB
  
  if (contentLength && parseInt(contentLength) > maxSize) {
    throw {
      message: "Request too large",
      statusCode: 413,
      statusText: "Payload Too Large"
    };
  }
  
  return {};
}
```

## Response Processing Middleware

### CORS Headers

```ts
// routes/middleware.ts
export default function(data, context) {
  const origin = context.request.headers.get("origin");
  const allowedOrigins = [
    "http://localhost:3000",
    "https://myapp.com",
    "https://admin.myapp.com"
  ];
  
  if (origin && allowedOrigins.includes(origin)) {
    context.response.headers({
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS"
    });
  }
  
  // Handle preflight requests
  if (context.request.method === "OPTIONS") {
    context.response.status(204);
    return { data: null }; // End request here
  }
  
  return {};
}
```

### Security Headers

```ts
// routes/middleware.ts
export default function(data, context) {
  // Add security headers
  context.response.headers({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-xss-protection": "1; mode=block",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": "default-src 'self'"
  });
  
  return {};
}
```

### Response Compression

```ts
// routes/middleware.ts
export default function(data, context) {
  const acceptEncoding = context.request.headers.get("accept-encoding");
  
  if (acceptEncoding?.includes("gzip")) {
    context.response.headers({
      "content-encoding": "gzip",
      "vary": "accept-encoding"
    });
    
    return {
      context: {
        compression: "gzip"
      }
    };
  }
  
  return {};
}
```

## Advanced Middleware Patterns

### Conditional Middleware

```ts
// routes/api/middleware.ts
export default function(data, context) {
  const { method, url } = context.request;
  
  // Skip authentication for health checks
  if (url.pathname === "/api/health") {
    return {};
  }
  
  // Skip authentication for public endpoints
  if (url.pathname.startsWith("/api/public/")) {
    return {};
  }
  
  // Require authentication for all other API endpoints
  return requireAuthentication(data, context);
}

function requireAuthentication(data, context) {
  // Authentication logic here
}
```

### Environment-based Middleware

```ts
// routes/middleware.ts
export default function(data, context) {
  const env = Deno.env.get("NODE_ENV");
  
  if (env === "development") {
    // Add development headers
    context.response.headers({
      "x-development-mode": "true",
      "access-control-allow-origin": "*"
    });
    
    // Log all requests in development
    console.log(`[DEV] ${context.request.method} ${context.request.url}`);
  }
  
  if (env === "production") {
    // Add production security headers
    context.response.headers({
      "strict-transport-security": "max-age=31536000",
      "x-robots-tag": "noindex"
    });
  }
  
  return {};
}
```

### Middleware with Dependencies

```ts
// routes/api/middleware.ts
export default async function(data, context) {
  const { cache, logger } = context.dependencies;
  
  // Log request
  logger.info("API request", {
    requestId: context.requestId,
    method: context.request.method,
    url: context.request.url
  });
  
  // Check cache for GET requests
  if (context.request.method === "GET") {
    const cacheKey = `request:${context.request.url}`;
    const cached = await cache.get(cacheKey);
    
    if (cached) {
      // Return cached response
      return {
        data: cached,
        context: {
          fromCache: true
        }
      };
    }
  }
  
  return {};
}
```

## Error Handling in Middleware

### Graceful Error Handling

```ts
// routes/middleware.ts
export default async function(data, context) {
  try {
    // Risky operation
    const externalData = await fetchExternalData();
    
    return {
      data: {
        ...data,
        externalData
      }
    };
  } catch (error) {
    // Log error but don't fail the request
    console.error("External data fetch failed:", error);
    
    // Continue without external data
    return {
      data: {
        ...data,
        externalData: null,
        externalDataError: true
      }
    };
  }
}
```

### Error Transformation

```ts
// routes/middleware.ts
export default function(data, context) {
  try {
    // Process request
    return validateAndTransform(data);
  } catch (error) {
    // Transform error into user-friendly format
    if (error.name === "ValidationError") {
      throw {
        message: "Invalid request data",
        statusCode: 400,
        details: error.details
      };
    }
    
    // Re-throw other errors
    throw error;
  }
}
```

## Testing Middleware

### Unit Testing

```ts
// tests/middleware.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import middleware from "../routes/middleware.ts";

Deno.test("middleware adds request timestamp", () => {
  const data = { test: "data" };
  const context = {
    requestId: "test-123",
    response: {
      headers: () => {}
    }
  };
  
  const result = middleware(data, context);
  
  assertEquals(typeof result.data.requestTimestamp, "number");
});
```

### Integration Testing

```ts
// tests/auth-middleware.test.ts
Deno.test("auth middleware blocks unauthenticated requests", async () => {
  const response = await fetch("http://localhost:8080/api/users");
  assertEquals(response.status, 401);
});

Deno.test("auth middleware allows authenticated requests", async () => {
  const response = await fetch("http://localhost:8080/api/users", {
    headers: {
      "authorization": "Bearer valid-token"
    }
  });
  assertEquals(response.status, 200);
});
```

## Best Practices

### ✅ Do

- Keep middleware focused on single responsibilities
- Use middleware for cross-cutting concerns (auth, logging, validation)
- Handle errors gracefully in middleware
- Use early returns for short-circuit logic
- Document middleware behavior and dependencies
- Test middleware independently
- Use TypeScript for better type safety

### ❌ Don't

- Don't put business logic in middleware
- Don't make middleware too complex
- Don't ignore middleware errors
- Don't forget to handle async operations properly
- Don't create circular dependencies between middleware
- Don't modify request data unnecessarily

## Common Middleware Examples

### Complete Authentication Stack

```ts
// routes/api/middleware.ts
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

export default async function(data, context) {
  const { url, method, headers } = context.request;
  
  // Skip auth for public routes
  if (url.pathname.startsWith("/api/public/")) {
    return {};
  }
  
  // Skip auth for OPTIONS requests
  if (method === "OPTIONS") {
    return {};
  }
  
  // Extract token
  const authHeader = headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw { message: "Authentication required", statusCode: 401 };
  }
  
  const token = authHeader.slice(7);
  
  try {
    // Verify JWT
    const secret = Deno.env.get("JWT_SECRET");
    const payload = await verify(token, secret, "HS256");
    
    // Check token expiration
    if (payload.exp && payload.exp < Date.now() / 1000) {
      throw { message: "Token expired", statusCode: 401 };
    }
    
    // Add user to context
    return {
      context: {
        user: {
          id: payload.sub,
          email: payload.email,
          roles: payload.roles || []
        }
      }
    };
  } catch (error) {
    throw { message: "Invalid token", statusCode: 401 };
  }
}
```

---

Middleware in Oxian provides a clean, composable way to handle cross-cutting concerns. Start with simple use cases and gradually build more sophisticated middleware pipelines as your application grows.

**Next Steps:**
- [Interceptors](./interceptors.md) - Before/after request hooks
- [Error Handling](./error-handling.md) - Global error handling
- [Security Guide](./security.md) - Security best practices
