# 🔧 Dependency Injection - Shared Services

Oxian's dependency injection system allows you to share services,
configurations, and resources across your routes using file-based composition.
Dependencies are resolved once per worker lifecycle and automatically composed
down the folder tree.

## Overview

Dependencies in Oxian are:

- **📁 File-based** - Defined in `dependencies.ts` files
- **🌳 Hierarchical** - Compose down the folder tree
- **⚡ Singleton** - Instantiated once per worker
- **🔄 Composable** - Later dependencies can override earlier ones
- **🚀 Async-friendly** - Support Promise-based initialization

```
routes/
├── dependencies.ts        # Global dependencies
├── index.ts              # Can use global deps
└── api/
    ├── dependencies.ts    # API-specific deps (inherits global)
    ├── users.ts          # Can use global + API deps
    └── admin/
        ├── dependencies.ts # Admin deps (inherits global + API)
        └── users.ts       # Can use global + API + admin deps
```

## Basic Usage

### Creating Dependencies

Create a `dependencies.ts` file in any folder:

```ts
// routes/dependencies.ts
export default async function () {
  // Create database connection
  const db = await createDatabase({
    url: Deno.env.get("DATABASE_URL") || "sqlite:///tmp/app.db",
  });

  // Create Redis client
  const redis = await createRedisClient({
    url: Deno.env.get("REDIS_URL") || "redis://localhost:6379",
  });

  // Create logger
  const logger = createLogger({
    level: Deno.env.get("LOG_LEVEL") || "info",
  });

  return { db, redis, logger };
}
```

### Using Dependencies

Access dependencies in your route handlers:

```ts
// routes/users/[id].ts
export function GET({ id }, { dependencies }) {
  const { db, logger } = dependencies;

  logger.info("Fetching user", { id });

  const user = db.users.findById(id);
  if (!user) {
    throw { message: "User not found", statusCode: 404 };
  }

  return user;
}

export async function PUT({ id, ...updates }, { dependencies }) {
  const { db, logger } = dependencies;

  logger.info("Updating user", { id, updates });

  const user = await db.users.update(id, updates);
  return user;
}
```

## Composition Rules

### Inheritance

Dependencies automatically inherit from parent folders:

```
routes/
├── dependencies.ts        # { db, logger }
└── api/
    ├── dependencies.ts    # { cache, auth }
    └── users.ts           # Has: { db, logger, cache, auth }
```

### Override Behavior

Later dependencies can override earlier ones:

```ts
// routes/dependencies.ts
export default function () {
  return {
    logger: createLogger({ level: "info" }),
    env: "development",
  };
}
```

```ts
// routes/api/dependencies.ts
export default function () {
  return {
    logger: createLogger({ level: "debug" }), // Overrides parent
    auth: createAuthService(), // New dependency
    // env: "development" is still available
  };
}
```

### Dependency Function Signature

The dependency function receives framework dependencies:

```ts
export default async function (framework) {
  // Framework provides utilities
  const { config, logger } = framework;

  // Use framework config
  const dbUrl = config.database?.url || "sqlite:///memory";

  const db = await createDatabase(dbUrl);
  const cache = createCache();

  return { db, cache };
}
```

## Advanced Patterns

### Environment-based Dependencies

Different dependencies per environment:

```ts
// routes/dependencies.ts
export default async function () {
  const env = Deno.env.get("NODE_ENV") || "development";

  if (env === "production") {
    return {
      db: await createPostgresDB({
        url: Deno.env.get("DATABASE_URL"),
      }),
      cache: await createRedisCache({
        url: Deno.env.get("REDIS_URL"),
      }),
      logger: createLogger({ level: "warn" }),
    };
  }

  if (env === "test") {
    return {
      db: createInMemoryDB(),
      cache: createInMemoryCache(),
      logger: createLogger({ level: "error" }),
    };
  }

  // Development
  return {
    db: await createSQLiteDB("./dev.db"),
    cache: createInMemoryCache(),
    logger: createLogger({ level: "debug" }),
  };
}
```

### Factory Pattern

Create dependencies using factory functions:

```ts
// routes/dependencies.ts
import { createUserService } from "../services/user.ts";
import { createEmailService } from "../services/email.ts";

export default async function () {
  const db = await createDatabase();

  // Factory functions with dependency injection
  const userService = createUserService(db);
  const emailService = createEmailService({
    apiKey: Deno.env.get("SENDGRID_API_KEY"),
    from: "noreply@example.com",
  });

  return { db, userService, emailService };
}
```

### Conditional Dependencies

Load dependencies conditionally:

```ts
// routes/api/dependencies.ts
export default async function () {
  const dependencies = {};

  // Always include
  dependencies.logger = createLogger();

  // Conditional dependencies
  if (Deno.env.get("ENABLE_CACHING") === "true") {
    dependencies.cache = await createRedisClient();
  }

  if (Deno.env.get("ENABLE_ANALYTICS") === "true") {
    dependencies.analytics = createAnalyticsClient();
  }

  if (Deno.env.get("ENABLE_MONITORING") === "true") {
    dependencies.monitoring = createMonitoringClient();
  }

  return dependencies;
}
```

### Lazy Loading

Load expensive dependencies on-demand:

```ts
// routes/dependencies.ts
export default function () {
  let mlModel = null;

  const loadMLModel = async () => {
    if (!mlModel) {
      mlModel = await loadModel("./model.json");
    }
    return mlModel;
  };

  return {
    database: createDatabase(),
    logger: createLogger(),
    // Lazy-loaded dependency
    getMLModel: loadMLModel,
  };
}
```

Usage:

```ts
// routes/predict.ts
export async function POST({ data }, { dependencies }) {
  const { getMLModel, logger } = dependencies;

  logger.info("Loading ML model...");
  const model = await getMLModel();

  const prediction = await model.predict(data);
  return { prediction };
}
```

## Database Integration

### Prisma Example

```ts
// routes/dependencies.ts
import { PrismaClient } from "@prisma/client";

export default async function () {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: Deno.env.get("DATABASE_URL"),
      },
    },
  });

  // Test connection
  await prisma.$connect();

  return {
    db: prisma,
    // Helper functions
    findUser: (id) => prisma.user.findUnique({ where: { id } }),
    createUser: (data) => prisma.user.create({ data }),
  };
}
```

### Deno KV Example

```ts
// routes/dependencies.ts
export default async function () {
  const kv = await Deno.openKv();

  return {
    kv,
    // Helper functions
    getUser: (id) => kv.get(["users", id]),
    setUser: (id, user) => kv.set(["users", id], user),
    listUsers: () => kv.list({ prefix: ["users"] }),
  };
}
```

### MongoDB Example

```ts
// routes/dependencies.ts
import { MongoClient } from "https://deno.land/x/mongo@v0.32.0/mod.ts";

export default async function () {
  const client = new MongoClient();
  await client.connect(Deno.env.get("MONGODB_URL"));

  const db = client.database("myapp");

  return {
    mongo: client,
    db,
    users: db.collection("users"),
    posts: db.collection("posts"),
  };
}
```

## Service Integration

### Authentication Service

```ts
// routes/api/dependencies.ts
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

export default function () {
  const secret = Deno.env.get("JWT_SECRET") || "development-secret";

  const auth = {
    verify: (token) => verify(token, secret, "HS256"),
    sign: (payload) => sign(payload, secret, "HS256"),
    decode: (token) => decode(token)[1],
  };

  return { auth };
}
```

### Email Service

```ts
// routes/dependencies.ts
export default function () {
  const sendgridApiKey = Deno.env.get("SENDGRID_API_KEY");

  const email = {
    async send({ to, subject, html, text }) {
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${sendgridApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: "noreply@example.com" },
          subject,
          content: [
            { type: "text/plain", value: text },
            { type: "text/html", value: html },
          ],
        }),
      });

      return response.ok;
    },
  };

  return { email };
}
```

### File Storage Service

```ts
// routes/dependencies.ts
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";

export default function () {
  const s3 = new S3Client({
    endPoint: Deno.env.get("S3_ENDPOINT"),
    port: 443,
    useSSL: true,
    region: Deno.env.get("S3_REGION"),
    accessKey: Deno.env.get("S3_ACCESS_KEY"),
    secretKey: Deno.env.get("S3_SECRET_KEY"),
    bucket: Deno.env.get("S3_BUCKET"),
  });

  const storage = {
    async upload(key, file) {
      return await s3.putObject(key, file);
    },
    async download(key) {
      return await s3.getObject(key);
    },
    async delete(key) {
      return await s3.deleteObject(key);
    },
  };

  return { storage };
}
```

## Configuration-based Dependencies

### Using Oxian Config

Configure dependencies through `oxian.config.json`:

```json
{
  "runtime": {
    "dependencies": {
      "initial": {
        "appName": "My API",
        "version": "1.0.0"
      },
      "bootstrapModule": "./bootstrap.ts"
    }
  }
}
```

```ts
// bootstrap.ts
export default async function createDependencies() {
  return {
    database: await createDatabase(),
    cache: await createCache(),
    logger: createLogger(),
  };
}
```

### Per-environment Config

```ts
// routes/dependencies.ts
export default async function ({ config }) {
  const env = config.environment || "development";

  const dbConfig = config.database?.[env] || {
    url: "sqlite:///memory",
  };

  return {
    db: await createDatabase(dbConfig),
    env,
    config,
  };
}
```

## Testing with Dependencies

### Mocking Dependencies

```ts
// tests/routes/users.test.ts
import { createMockDependencies } from "../helpers/mocks.ts";

Deno.test("GET /users returns user list", async () => {
  const mockDb = {
    users: {
      findAll: () => [
        { id: 1, name: "John" },
        { id: 2, name: "Jane" },
      ],
    },
  };

  const dependencies = createMockDependencies({ db: mockDb });

  // Test your handler with mock dependencies
  const result = await GET({}, { dependencies });

  assertEquals(result.users.length, 2);
});
```

### Test-specific Dependencies

```ts
// routes/dependencies.ts
export default async function () {
  if (Deno.env.get("NODE_ENV") === "test") {
    return {
      db: createInMemoryDatabase(),
      logger: createSilentLogger(),
      cache: createMockCache(),
    };
  }

  // Production dependencies
  return {
    db: await createProductionDatabase(),
    logger: createProductionLogger(),
    cache: await createRedisCache(),
  };
}
```

## Error Handling

### Graceful Dependency Failures

```ts
// routes/dependencies.ts
export default async function () {
  const dependencies = {};

  // Essential dependency - fail fast
  try {
    dependencies.db = await createDatabase();
  } catch (error) {
    console.error("Failed to connect to database:", error);
    throw error; // Stop application startup
  }

  // Optional dependency - graceful degradation
  try {
    dependencies.cache = await createRedisClient();
  } catch (error) {
    console.warn("Redis unavailable, using in-memory cache:", error);
    dependencies.cache = createInMemoryCache();
  }

  return dependencies;
}
```

### Dependency Health Checks

```ts
// routes/dependencies.ts
export default async function () {
  const db = await createDatabase();
  const cache = await createCache();

  // Add health check methods
  const health = {
    async check() {
      const results = {};

      try {
        await db.ping();
        results.database = "healthy";
      } catch {
        results.database = "unhealthy";
      }

      try {
        await cache.ping();
        results.cache = "healthy";
      } catch {
        results.cache = "unhealthy";
      }

      return results;
    },
  };

  return { db, cache, health };
}
```

Usage:

```ts
// routes/health.ts
export async function GET(_, { dependencies }) {
  const { health } = dependencies;

  const status = await health.check();
  const isHealthy = Object.values(status).every((s) => s === "healthy");

  return {
    status: isHealthy ? "healthy" : "degraded",
    services: status,
    timestamp: new Date().toISOString(),
  };
}
```

## Best Practices

### ✅ Do

- Keep dependencies stateless and reusable
- Use async initialization for I/O operations
- Implement graceful degradation for optional services
- Add health checks for external dependencies
- Use environment variables for configuration
- Clean up resources on shutdown
- Test with mock dependencies

### ❌ Don't

- Don't create request-scoped dependencies (use middleware instead)
- Don't leak sensitive data in dependency objects
- Don't ignore dependency initialization errors
- Don't create circular dependencies
- Don't make dependencies overly complex
- Don't forget to handle connection timeouts

## Examples

### Complete CRUD API Dependencies

```ts
// routes/dependencies.ts
export default async function () {
  // Database
  const db = await createDatabase({
    url: Deno.env.get("DATABASE_URL"),
  });

  // Validation
  const validator = createValidator();

  // User service
  const userService = {
    async findAll(filters = {}) {
      return db.users.findMany({ where: filters });
    },

    async findById(id) {
      const user = await db.users.findUnique({ where: { id } });
      if (!user) throw { message: "User not found", statusCode: 404 };
      return user;
    },

    async create(data) {
      await validator.validate("user", data);
      return db.users.create({ data });
    },

    async update(id, data) {
      await this.findById(id); // Ensure exists
      await validator.validate("userUpdate", data);
      return db.users.update({ where: { id }, data });
    },

    async delete(id) {
      await this.findById(id); // Ensure exists
      return db.users.delete({ where: { id } });
    },
  };

  return { db, validator, userService };
}
```

---

Dependency injection in Oxian is powerful yet simple. Start with basic services
and gradually build more sophisticated patterns as your application grows.

**Next Steps:**

- [Middleware Guide](./middleware.md) - Request processing
- [Interceptors](./interceptors.md) - Cross-cutting concerns
- [Configuration](./configuration.md) - Environment setup
