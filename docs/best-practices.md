# 📋 Best Practices - Production-Ready Patterns

This guide consolidates proven patterns, architectural decisions, and
operational practices for building robust, scalable, and maintainable APIs with
Oxian. Learn from real-world experience to avoid common pitfalls and maximize
your application's potential.

## Project Structure & Organization

### Recommended Directory Structure

```
my-oxian-api/
├── oxian.config.json              # Configuration
├── deno.json                      # Deno configuration
├── .env.example                   # Environment template
├── README.md                      # Project documentation
├── routes/                        # API routes
│   ├── dependencies.ts            # Global dependencies
│   ├── middleware.ts              # Global middleware
│   ├── interceptors.ts            # Global interceptors
│   ├── index.ts                   # Root endpoint
│   ├── health.ts                  # Health check
│   └── api/                       # API namespace
│       ├── dependencies.ts        # API-specific dependencies
│       ├── middleware.ts          # API auth/validation
│       ├── v1/                    # API versioning
│       │   ├── users/
│       │   │   ├── index.ts       # GET,POST /api/v1/users
│       │   │   ├── [id].ts        # GET,PUT,DELETE /api/v1/users/:id
│       │   │   └── [id]/
│       │   │       ├── posts.ts   # GET,POST /api/v1/users/:id/posts
│       │   │       └── settings.ts
│       │   ├── posts/
│       │   └── auth/
│       └── v2/                    # Future API version
├── types/                         # Shared TypeScript types
│   ├── api.ts                     # API types
│   ├── database.ts                # Database types
│   └── auth.ts                    # Authentication types
├── services/                      # Business logic services
│   ├── user.ts                    # User service
│   ├── email.ts                   # Email service
│   └── storage.ts                 # File storage service
├── utils/                         # Utility functions
│   ├── validation.ts              # Input validation
│   ├── crypto.ts                  # Cryptographic utilities
│   └── constants.ts               # Application constants
├── migrations/                    # Database migrations
│   ├── 001_initial.sql
│   └── 002_add_users.sql
├── tests/                         # Test files
│   ├── unit/                      # Unit tests
│   ├── integration/               # Integration tests
│   └── e2e/                       # End-to-end tests
├── scripts/                       # Automation scripts
│   ├── migrate.ts                 # Database migration
│   ├── seed.ts                    # Data seeding
│   └── deploy.sh                  # Deployment script
└── docs/                          # Additional documentation
    ├── api.md                     # API documentation
    └── deployment.md              # Deployment guide
```

### File Naming Conventions

```
✅ Good naming:
- users.ts (plural for collections)
- [id].ts (clear parameter names)
- dependencies.ts (standard file names)
- userService.ts (camelCase for services)

❌ Avoid:
- user.ts (singular for collections)
- [x].ts (unclear parameter names)
- deps.ts (abbreviated file names)
- user_service.ts (snake_case in TypeScript)
```

## Route Design Patterns

### RESTful API Design

```typescript
// ✅ Good: RESTful route structure
routes/
├── users.ts                       # GET,POST /users
├── users/
│   ├── [id].ts                   # GET,PUT,DELETE /users/:id
│   └── [id]/
│       ├── posts.ts              # GET,POST /users/:id/posts
│       ├── posts/
│       │   └── [postId].ts       # GET,PUT,DELETE /users/:id/posts/:postId
│       └── avatar.ts             # PUT,DELETE /users/:id/avatar

// ✅ Good: Clear HTTP method semantics
export function GET({ id }) {      // Retrieve resource
  return userService.findById(id);
}

export function POST(data) {       // Create resource
  return userService.create(data);
}

export function PUT({ id, ...data }) {  // Update entire resource
  return userService.update(id, data);
}

export function PATCH({ id, ...data }) { // Partial update
  return userService.patch(id, data);
}

export function DELETE({ id }) {   // Remove resource
  return userService.delete(id);
}
```

### API Versioning

```typescript
// ✅ Good: URL-based versioning
routes/
├── api/
│   ├── v1/
│   │   ├── users.ts              # /api/v1/users
│   │   └── posts.ts              # /api/v1/posts
│   └── v2/
│       ├── users.ts              # /api/v2/users (breaking changes)
│       └── posts.ts              # /api/v2/posts

// ✅ Good: Header-based versioning support
export function GET(data, { request }) {
  const version = request.headers.get('api-version') || '1';
  
  switch (version) {
    case '1':
      return getUsersV1();
    case '2':
      return getUsersV2();
    default:
      throw { message: 'Unsupported API version', statusCode: 400 };
  }
}
```

### Error Handling Patterns

```typescript
// ✅ Good: Consistent error responses
export function GET({ id }) {
  if (!id) {
    throw {
      message: "User ID is required",
      statusCode: 400,
      code: "MISSING_USER_ID",
      details: { parameter: "id" },
    };
  }

  const user = userService.findById(id);
  if (!user) {
    throw {
      message: "User not found",
      statusCode: 404,
      code: "USER_NOT_FOUND",
      details: { userId: id },
    };
  }

  return user;
}

// ✅ Good: Global error handling
// routes/interceptors.ts
export async function afterRun(resultOrError, context) {
  if (resultOrError instanceof Error) {
    // Log error with context
    logger.error("Request failed", {
      requestId: context.requestId,
      route: context.oxian.route,
      error: resultOrError.message,
      stack: resultOrError.stack,
    });

    // Transform for client
    return {
      error: {
        message: "Internal server error",
        code: "INTERNAL_ERROR",
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return resultOrError;
}
```

## Dependency Injection Best Practices

### Service Layer Architecture

```typescript
// ✅ Good: Clear service separation
// routes/dependencies.ts
export default async function () {
  // Core infrastructure
  const database = await createDatabase();
  const cache = await createRedisClient();
  const logger = createLogger();

  // Business services
  const userService = createUserService(database, cache);
  const emailService = createEmailService();
  const storageService = createStorageService();

  // Cross-cutting concerns
  const auditService = createAuditService(database);
  const metricsService = createMetricsService();

  return {
    // Infrastructure
    database,
    cache,
    logger,

    // Services
    userService,
    emailService,
    storageService,
    auditService,
    metricsService,

    // Utilities
    validator: createValidator(),
    encryptor: createEncryptor(),
  };
}

// services/user.ts
export function createUserService(database, cache) {
  return {
    async findById(id) {
      // Try cache first
      const cached = await cache.get(`user:${id}`);
      if (cached) return cached;

      // Fetch from database
      const user = await database.users.findById(id);
      if (!user) throw new UserNotFoundError(id);

      // Cache result
      await cache.set(`user:${id}`, user, 300);

      return user;
    },

    async create(userData) {
      // Validate
      const validUser = await this.validateUserData(userData);

      // Create
      const user = await database.users.create(validUser);

      // Clear relevant caches
      await cache.invalidate("users:*");

      return user;
    },

    async validateUserData(data) {
      const schema = z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        age: z.number().min(0).max(150).optional(),
      });

      return schema.parse(data);
    },
  };
}
```

### Environment-Based Configuration

```typescript
// ✅ Good: Environment-specific dependencies
// routes/dependencies.ts
export default async function () {
  const env = Deno.env.get("NODE_ENV") || "development";

  const config = {
    development: {
      database: {
        url: "sqlite:///./dev.db",
        debug: true,
      },
      cache: {
        type: "memory",
      },
      email: {
        provider: "console", // Log emails to console
      },
    },

    test: {
      database: {
        url: "sqlite:///:memory:",
        debug: false,
      },
      cache: {
        type: "memory",
      },
      email: {
        provider: "mock",
      },
    },

    production: {
      database: {
        url: Deno.env.get("DATABASE_URL"),
        pool: { min: 5, max: 20 },
        debug: false,
      },
      cache: {
        type: "redis",
        url: Deno.env.get("REDIS_URL"),
      },
      email: {
        provider: "sendgrid",
        apiKey: Deno.env.get("SENDGRID_API_KEY"),
      },
    },
  };

  const envConfig = config[env];
  if (!envConfig) {
    throw new Error(`Unknown environment: ${env}`);
  }

  return createServices(envConfig);
}
```

## Middleware Patterns

### Authentication Middleware

```typescript
// ✅ Good: Layered authentication
// routes/middleware.ts (Global CORS and security)
export default function (data, context) {
  // Add security headers
  context.response.headers({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-xss-protection": "1; mode=block",
  });

  // Handle CORS
  const origin = context.request.headers.get("origin");
  if (isAllowedOrigin(origin)) {
    context.response.headers({
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
    });
  }

  return {};
}

// routes/api/middleware.ts (API authentication)
export default async function (data, context) {
  const { request } = context;

  // Skip auth for public endpoints
  if (isPublicEndpoint(request.url)) {
    return {};
  }

  // Extract and verify token
  const token = extractToken(request);
  if (!token) {
    throw { message: "Authentication required", statusCode: 401 };
  }

  try {
    const user = await verifyToken(token);
    return { context: { user } };
  } catch (error) {
    throw { message: "Invalid token", statusCode: 401 };
  }
}

// routes/api/admin/middleware.ts (Role-based access)
export default function (data, { user }) {
  if (!user?.roles?.includes("admin")) {
    throw {
      message: "Admin access required",
      statusCode: 403,
    };
  }

  return {};
}
```

### Validation Middleware

```typescript
// ✅ Good: Reusable validation middleware
// middleware/validation.ts
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

export function createValidationMiddleware(schemas) {
  return function (data, { request }) {
    const method = request.method;
    const schema = schemas[method];

    if (!schema) return {};

    try {
      const validatedData = schema.parse(data);
      return { data: validatedData };
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw {
          message: "Validation failed",
          statusCode: 400,
          code: "VALIDATION_ERROR",
          details: error.errors,
        };
      }
      throw error;
    }
  };
}

// routes/api/users/middleware.ts
const userSchemas = {
  POST: z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    age: z.number().min(0).max(150).optional(),
  }),

  PUT: z.object({
    id: z.string(),
    name: z.string().min(1).max(100).optional(),
    email: z.string().email().optional(),
    age: z.number().min(0).max(150).optional(),
  }),
};

export default createValidationMiddleware(userSchemas);
```

## Testing Strategies

### Unit Testing

```typescript
// ✅ Good: Comprehensive unit tests
// tests/unit/user-service.test.ts
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { createUserService } from "../../services/user.ts";

// Mock dependencies
const mockDatabase = {
  users: {
    findById: async (id) => ({ id, name: "Test User" }),
    create: async (data) => ({ id: "123", ...data }),
    update: async (id, data) => ({ id, ...data }),
  },
};

const mockCache = {
  get: async () => null,
  set: async () => {},
  invalidate: async () => {},
};

Deno.test("UserService", async (t) => {
  const userService = createUserService(mockDatabase, mockCache);

  await t.step("should find user by ID", async () => {
    const user = await userService.findById("123");
    assertEquals(user.id, "123");
    assertEquals(user.name, "Test User");
  });

  await t.step("should create user with valid data", async () => {
    const userData = {
      name: "John Doe",
      email: "john@example.com",
      age: 30,
    };

    const user = await userService.create(userData);
    assertEquals(user.name, userData.name);
    assertEquals(user.email, userData.email);
  });

  await t.step("should throw error for invalid data", async () => {
    await assertThrows(
      () => userService.create({ name: "", email: "invalid" }),
      Error,
      "Validation failed",
    );
  });
});
```

### Integration Testing

```typescript
// ✅ Good: Integration tests with real server
// tests/integration/api.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

const API_BASE = "http://localhost:8080";

Deno.test("User API Integration", async (t) => {
  let userId: string;

  await t.step("should create user", async () => {
    const response = await fetch(`${API_BASE}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "John Doe",
        email: "john@example.com",
      }),
    });

    assertEquals(response.status, 201);

    const user = await response.json();
    assertEquals(user.name, "John Doe");

    userId = user.id;
  });

  await t.step("should get user by ID", async () => {
    const response = await fetch(`${API_BASE}/api/v1/users/${userId}`);
    assertEquals(response.status, 200);

    const user = await response.json();
    assertEquals(user.id, userId);
  });

  await t.step("should update user", async () => {
    const response = await fetch(`${API_BASE}/api/v1/users/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Jane Doe",
      }),
    });

    assertEquals(response.status, 200);

    const user = await response.json();
    assertEquals(user.name, "Jane Doe");
  });

  await t.step("should delete user", async () => {
    const response = await fetch(`${API_BASE}/api/v1/users/${userId}`, {
      method: "DELETE",
    });

    assertEquals(response.status, 200);
  });
});
```

### Test Utilities

```typescript
// ✅ Good: Reusable test utilities
// tests/utils/test-server.ts
export class TestServer {
  private process?: Deno.ChildProcess;

  async start(port = 8080) {
    this.process = new Deno.Command("deno", {
      args: ["run", "-A", "cli.ts", "--port", port.toString()],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Wait for server to be ready
    await this.waitForReady(port);
  }

  async stop() {
    if (this.process) {
      this.process.kill("SIGTERM");
      await this.process.status;
    }
  }

  private async waitForReady(port: number) {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) return;
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error("Server failed to start");
  }
}

// tests/utils/api-client.ts
export class APIClient {
  constructor(private baseURL = "http://localhost:8080") {}

  async request(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseURL}${path}`, {
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    const data = await response.json();

    return {
      status: response.status,
      headers: response.headers,
      data,
    };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.request(path, { method: "GET", headers });
  }

  post(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
  }

  put(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
      headers,
    });
  }

  delete(path: string, headers?: Record<string, string>) {
    return this.request(path, { method: "DELETE", headers });
  }
}
```

## Security Best Practices

### Input Validation & Sanitization

```typescript
// ✅ Good: Comprehensive input validation
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import DOMPurify from "https://esm.sh/dompurify@3.0.5";

const UserCreateSchema = z.object({
  name: z.string()
    .min(1, "Name is required")
    .max(100, "Name too long")
    .regex(/^[a-zA-Z\s]+$/, "Name contains invalid characters"),

  email: z.string()
    .email("Invalid email format")
    .max(255, "Email too long"),

  age: z.number()
    .int("Age must be an integer")
    .min(0, "Age cannot be negative")
    .max(150, "Age too high")
    .optional(),

  bio: z.string()
    .max(1000, "Bio too long")
    .optional()
    .transform((bio) => bio ? DOMPurify.sanitize(bio) : bio),
});

export function POST(data) {
  const validatedData = UserCreateSchema.parse(data);
  return userService.create(validatedData);
}
```

### Authentication & Authorization

```typescript
// ✅ Good: Secure authentication patterns
// utils/auth.ts
import { sign, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { compare, hash } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

export class AuthService {
  private secret = Deno.env.get("JWT_SECRET");

  async hashPassword(password: string): Promise<string> {
    if (password.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }
    return await hash(password);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return await compare(password, hash);
  }

  async createToken(
    user: { id: string; email: string; roles: string[] },
  ): Promise<string> {
    const payload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      iat: Date.now() / 1000,
      exp: Date.now() / 1000 + (24 * 60 * 60), // 24 hours
    };

    return await sign(payload, this.secret, "HS256");
  }

  async verifyToken(token: string): Promise<any> {
    try {
      const payload = await verify(token, this.secret, "HS256");

      // Check expiration
      if (payload.exp && payload.exp < Date.now() / 1000) {
        throw new Error("Token expired");
      }

      return payload;
    } catch (error) {
      throw new Error("Invalid token");
    }
  }

  hasPermission(user: any, requiredRoles: string[]): boolean {
    if (!user?.roles) return false;
    return requiredRoles.some((role) => user.roles.includes(role));
  }
}
```

### Rate Limiting

```typescript
// ✅ Good: Flexible rate limiting
// middleware/rate-limit.ts
export class RateLimiter {
  private windows = new Map<string, { count: number; resetTime: number }>();

  constructor(
    private maxRequests = 100,
    private windowMs = 60000, // 1 minute
    private keyGenerator = (request: Request) =>
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown",
  ) {}

  check(
    request: Request,
  ): { allowed: boolean; remaining: number; resetTime: number } {
    const key = this.keyGenerator(request);
    const now = Date.now();

    let window = this.windows.get(key);

    if (!window || now > window.resetTime) {
      window = { count: 1, resetTime: now + this.windowMs };
      this.windows.set(key, window);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        resetTime: window.resetTime,
      };
    }

    window.count++;

    if (window.count > this.maxRequests) {
      return { allowed: false, remaining: 0, resetTime: window.resetTime };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - window.count,
      resetTime: window.resetTime,
    };
  }

  // Clean up old windows periodically
  cleanup() {
    const now = Date.now();
    for (const [key, window] of this.windows) {
      if (now > window.resetTime) {
        this.windows.delete(key);
      }
    }
  }
}

// Usage in middleware
const rateLimiter = new RateLimiter(100, 60000);

export default function (data, { request, response }) {
  const result = rateLimiter.check(request);

  // Add rate limit headers
  response.headers({
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": result.remaining.toString(),
    "x-ratelimit-reset": result.resetTime.toString(),
  });

  if (!result.allowed) {
    throw {
      message: "Rate limit exceeded",
      statusCode: 429,
      headers: {
        "retry-after": Math.ceil((result.resetTime - Date.now()) / 1000)
          .toString(),
      },
    };
  }

  return {};
}
```

## Performance Optimization

### Caching Strategies

```typescript
// ✅ Good: Multi-level caching
// services/cache.ts
export class CacheService {
  constructor(
    private memoryCache = new Map(),
    private redisClient?: RedisClient,
    private defaultTTL = 300, // 5 minutes
  ) {}

  async get<T>(key: string): Promise<T | null> {
    // Try memory cache first (fastest)
    if (this.memoryCache.has(key)) {
      const { value, expiry } = this.memoryCache.get(key);
      if (Date.now() < expiry) {
        return value;
      }
      this.memoryCache.delete(key);
    }

    // Try Redis cache (persistent)
    if (this.redisClient) {
      const value = await this.redisClient.get(key);
      if (value) {
        const parsed = JSON.parse(value);
        // Store in memory cache for faster access
        this.memoryCache.set(key, {
          value: parsed,
          expiry: Date.now() + (this.defaultTTL * 1000),
        });
        return parsed;
      }
    }

    return null;
  }

  async set(key: string, value: any, ttl = this.defaultTTL): Promise<void> {
    const expiry = Date.now() + (ttl * 1000);

    // Store in memory cache
    this.memoryCache.set(key, { value, expiry });

    // Store in Redis cache
    if (this.redisClient) {
      await this.redisClient.setex(key, ttl, JSON.stringify(value));
    }
  }

  async invalidate(pattern: string): Promise<void> {
    // Clear memory cache
    for (const key of this.memoryCache.keys()) {
      if (key.includes(pattern)) {
        this.memoryCache.delete(key);
      }
    }

    // Clear Redis cache
    if (this.redisClient) {
      const keys = await this.redisClient.keys(`*${pattern}*`);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
      }
    }
  }
}
```

### Database Optimization

```typescript
// ✅ Good: Optimized database patterns
// services/database.ts
export class DatabaseService {
  constructor(private db: Database) {}

  // Use transactions for consistency
  async createUserWithProfile(userData: any, profileData: any) {
    return await this.db.transaction(async (tx) => {
      const user = await tx.users.create(userData);
      const profile = await tx.profiles.create({
        ...profileData,
        userId: user.id,
      });
      return { user, profile };
    });
  }

  // Use connection pooling
  async findUsersWithPagination(page = 1, limit = 20) {
    const offset = (page - 1) * limit;

    // Use prepared statements for performance
    const [users, total] = await Promise.all([
      this.db.users.findMany({
        limit,
        offset,
        select: ["id", "name", "email", "createdAt"], // Only select needed fields
        orderBy: { createdAt: "desc" },
      }),
      this.db.users.count(),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  // Use indexes for common queries
  async findUsersByEmail(emails: string[]) {
    // Batch queries instead of N+1
    return await this.db.users.findMany({
      where: { email: { in: emails } },
      select: ["id", "name", "email"],
    });
  }
}
```

## Monitoring & Observability

### Structured Logging

```typescript
// ✅ Good: Comprehensive logging strategy
// utils/logger.ts
export class Logger {
  constructor(
    private service = "oxian-api",
    private version = Deno.env.get("APP_VERSION") || "unknown",
  ) {}

  private log(level: string, message: string, meta: any = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
      version: this.version,
      ...meta,
    };

    // Use appropriate console method
    switch (level) {
      case "error":
        console.error(JSON.stringify(logEntry));
        break;
      case "warn":
        console.warn(JSON.stringify(logEntry));
        break;
      case "debug":
        console.debug(JSON.stringify(logEntry));
        break;
      default:
        console.log(JSON.stringify(logEntry));
    }
  }

  info(message: string, meta?: any) {
    this.log("info", message, meta);
  }

  error(message: string, error?: Error, meta?: any) {
    this.log("error", message, {
      ...meta,
      error: error
        ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
        : undefined,
    });
  }

  warn(message: string, meta?: any) {
    this.log("warn", message, meta);
  }

  debug(message: string, meta?: any) {
    this.log("debug", message, meta);
  }
}

// Request logging interceptor
export async function beforeRun(data, { requestId, request, oxian }) {
  logger.info("Request started", {
    requestId,
    method: request.method,
    url: request.url,
    route: oxian.route,
    userAgent: request.headers.get("user-agent"),
    clientIp: request.headers.get("x-forwarded-for"),
  });

  oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError, { requestId, request, oxian }) {
  const duration = Math.round(performance.now() - oxian.startedAt);
  const isError = resultOrError instanceof Error;

  logger.info("Request completed", {
    requestId,
    method: request.method,
    route: oxian.route,
    duration,
    success: !isError,
    statusCode: isError ? 500 : 200,
  });

  if (isError) {
    logger.error("Request failed", resultOrError, {
      requestId,
      route: oxian.route,
    });
  }
}
```

### Health Monitoring

```typescript
// ✅ Good: Comprehensive health checks
// routes/health.ts
export async function GET(_, { dependencies }) {
  const { database, cache, externalAPI } = dependencies;

  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: Deno.env.get("APP_VERSION") || "unknown",
    uptime: performance.now(),
    checks: {} as Record<string, any>,
  };

  // Database health
  try {
    const start = performance.now();
    await database.ping();
    health.checks.database = {
      status: "healthy",
      responseTime: Math.round(performance.now() - start),
    };
  } catch (error) {
    health.status = "degraded";
    health.checks.database = {
      status: "unhealthy",
      error: error.message,
    };
  }

  // Cache health
  try {
    const start = performance.now();
    await cache.ping();
    health.checks.cache = {
      status: "healthy",
      responseTime: Math.round(performance.now() - start),
    };
  } catch (error) {
    health.status = "degraded";
    health.checks.cache = {
      status: "unhealthy",
      error: error.message,
    };
  }

  // External service health
  try {
    const start = performance.now();
    await externalAPI.healthCheck();
    health.checks.external_api = {
      status: "healthy",
      responseTime: Math.round(performance.now() - start),
    };
  } catch (error) {
    health.status = "degraded";
    health.checks.external_api = {
      status: "unhealthy",
      error: error.message,
    };
  }

  // Memory usage
  const memUsage = Deno.memoryUsage();
  health.checks.memory = {
    status: memUsage.heapUsed < 100 * 1024 * 1024 ? "healthy" : "warning", // 100MB threshold
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    external: memUsage.external,
  };

  const statusCode = health.status === "healthy" ? 200 : 503;
  return new Response(JSON.stringify(health), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
```

## Deployment Best Practices

### Environment Management

```bash
# ✅ Good: Environment-specific configurations
# .env.development
NODE_ENV=development
LOG_LEVEL=debug
HOT_RELOAD=true
DATABASE_URL=sqlite:///./dev.db
REDIS_URL=redis://localhost:6379

# .env.staging
NODE_ENV=staging
LOG_LEVEL=info
HOT_RELOAD=false
DATABASE_URL=${STAGING_DATABASE_URL}
REDIS_URL=${STAGING_REDIS_URL}

# .env.production
NODE_ENV=production
LOG_LEVEL=warn
HOT_RELOAD=false
DATABASE_URL=${PRODUCTION_DATABASE_URL}
REDIS_URL=${PRODUCTION_REDIS_URL}
```

### Docker Best Practices

```dockerfile
# ✅ Good: Optimized Dockerfile
FROM denoland/deno:alpine-1.40.0

# Create app directory and user
RUN addgroup -g 1001 -S deno && \
    adduser -S deno -u 1001
WORKDIR /app

# Copy dependency files first (better caching)
COPY deno.json deno.lock ./
COPY oxian.config.json ./

# Cache dependencies
RUN deno cache --lock=deno.lock cli.ts

# Copy application code
COPY --chown=deno:deno . .

# Switch to non-root user
USER deno

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD deno run -A --quiet -c deno.json -r https://deno.land/std/http/file_server.ts --port 8080 || exit 1

# Start application
CMD ["deno", "run", "-A", "-c", "deno.json", "cli.ts"]
```

## Error Recovery & Resilience

### Circuit Breaker Pattern

```typescript
// ✅ Good: Circuit breaker implementation
export class CircuitBreaker {
  private failures = 0;
  private state: "closed" | "open" | "half-open" = "closed";
  private nextAttempt = 0;

  constructor(
    private threshold = 5,
    private timeout = 60000,
    private resetTimeout = 30000,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() < this.nextAttempt) {
        throw new Error("Circuit breaker is open");
      }
      this.state = "half-open";
    }

    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Operation timeout")), this.timeout)
        ),
      ]);

      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = "open";
      this.nextAttempt = Date.now() + this.resetTimeout;
    }
  }
}
```

### Graceful Degradation

```typescript
// ✅ Good: Fallback strategies
export async function GET({ id }, { dependencies }) {
  const { primaryDB, cacheDB, fallbackAPI } = dependencies;

  // Try primary source
  try {
    return await primaryDB.users.findById(id);
  } catch (primaryError) {
    logger.warn("Primary DB failed, trying cache", {
      error: primaryError.message,
    });

    // Try cache
    try {
      const cached = await cacheDB.get(`user:${id}`);
      if (cached) {
        return { ...cached, source: "cache" };
      }
    } catch (cacheError) {
      logger.warn("Cache failed, trying fallback API", {
        error: cacheError.message,
      });
    }

    // Try fallback API
    try {
      const fallbackData = await fallbackAPI.getUser(id);
      return { ...fallbackData, source: "fallback" };
    } catch (fallbackError) {
      logger.error("All sources failed", fallbackError);
    }

    // All sources failed - return minimal response
    throw {
      message: "User service temporarily unavailable",
      statusCode: 503,
      code: "SERVICE_UNAVAILABLE",
    };
  }
}
```

## Common Anti-Patterns to Avoid

### ❌ Don't Do These

```typescript
// ❌ Bad: Putting business logic in routes
export function POST({ name, email }) {
  // Don't put validation, database calls, etc. directly here
  if (!name) throw { message: "Name required", statusCode: 400 };

  const user = database.users.create({ name, email });
  sendWelcomeEmail(user.email);
  updateUserStats();

  return user;
}

// ✅ Good: Delegate to services
export function POST(data, { dependencies }) {
  const { userService } = dependencies;
  return userService.createUser(data);
}

// ❌ Bad: Inconsistent error responses
export function GET({ id }) {
  if (!id) return { error: "Missing ID" }; // Wrong: should throw

  const user = findUser(id);
  if (!user) throw "User not found"; // Wrong: inconsistent format

  return user;
}

// ❌ Bad: Ignoring request context
export function GET() {
  // Wrong: hardcoded responses without using context
  return { message: "Hello World" };
}

// ✅ Good: Use request context
export function GET(data, { requestId, user }) {
  return {
    message: "Hello World",
    requestId,
    user: user?.name,
  };
}

// ❌ Bad: Not handling async errors
export async function GET() {
  const data = await externalAPI.fetch(); // Wrong: no error handling
  return data;
}

// ✅ Good: Proper error handling
export async function GET() {
  try {
    const data = await externalAPI.fetch();
    return data;
  } catch (error) {
    throw {
      message: "External service unavailable",
      statusCode: 503,
      code: "EXTERNAL_SERVICE_ERROR",
    };
  }
}
```

---

Following these best practices will help you build robust, maintainable, and
scalable APIs with Oxian. Start with the basics and gradually implement more
advanced patterns as your application grows.

**Next Steps:**

- [API Reference](./api-reference.md) - Complete API documentation
- [Deployment Guide](./deployment.md) - Production deployment
- [Examples Repository](https://github.com/oxian-org/examples) - Real-world
  examples
