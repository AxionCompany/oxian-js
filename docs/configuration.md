# ⚙️ Configuration - Customize Your Oxian App

Oxian provides flexible configuration through JSON or TypeScript files,
environment variables, and command-line arguments. This guide covers all
configuration options and best practices.

## Configuration Files

### JSON Configuration

The simplest way to configure Oxian is with `oxian.config.json`:

```json
{
  "root": ".",
  "basePath": "/api",
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
  "logging": {
    "level": "info"
  }
}
```

### Hypervisor OTLP Collector (TypeScript config)

Enable a minimal built-in OTLP HTTP collector inside the hypervisor. Workers
default their OTLP endpoint to this collector when `logging.otel.enabled=true`
and no explicit `endpoint` is set.

```typescript
{
  "runtime": {
    "hv": {
      "otelCollector": {
        "enabled": boolean,
        "port": number,        // default 4318
        "pathPrefix": string,  // default "/v1"
        // Called per export: { kind: "traces"|"metrics"|"logs", headers, body, contentType, project }
        "onExport": Function
      }
    }
  }
}
```

### TypeScript Configuration

For dynamic configuration, use `oxian.config.ts`:

```ts
// oxian.config.ts
export default {
  server: {
    port: parseInt(Deno.env.get("PORT") || "8080"),
  },
  routing: {
    routesDir: Deno.env.get("NODE_ENV") === "test" ? "test-routes" : "routes",
  },
  runtime: {
    hotReload: Deno.env.get("NODE_ENV") !== "production",
    dependencies: {
      initial: {
        environment: Deno.env.get("NODE_ENV") || "development",
        version: "1.0.0",
      },
    },
  },
  security: {
    cors: {
      allowedOrigins: Deno.env.get("ALLOWED_ORIGINS")?.split(",") || ["*"],
    },
  },
  logging: {
    level: (Deno.env.get("LOG_LEVEL") as any) || "info",
  },
};
```

### JavaScript Configuration

You can also use `oxian.config.js`:

```js
// oxian.config.js
export default {
  server: {
    port: process.env.PORT || 8080,
  },
  runtime: {
    hotReload: process.env.NODE_ENV !== "production",
  },
};
```

## Configuration Schema

### Root Options

```typescript
{
  // Application root directory
  "root": string,                    // default: "."
  
  // Base path for all routes
  "basePath": string,                // default: "/"
  
  // Server configuration
  "server": ServerConfig,
  
  // Routing configuration  
  "routing": RoutingConfig,
  
  // Runtime behavior
  "runtime": RuntimeConfig,
  
  // Security settings
  "security": SecurityConfig,
  
  // Logging configuration
  "logging": LoggingConfig,
  
  // Loader configuration
  "loaders": LoadersConfig,
  
  // Preferred top-level web config used by workers (fallback: runtime.hv.web)
  "web": {
    "devProxyTarget": string,
    "staticDir": string,
    "staticCacheControl": string
  },
  
  // Optional prepare commands executed before workers start
  "prepare": Array<string | { cmd: string; cwd?: string; env?: Record<string,string> }>
}
```

### Server Configuration

```typescript
{
  "server": {
    // Port to listen on
    "port": number,                  // default: 8080
    
    // Hostname to bind to
    "hostname": string,              // default: "0.0.0.0"
    
    // TLS configuration
    "tls": {
      "certFile": string,
      "keyFile": string
    }
  }
}
```

### Routing Configuration

```typescript
{
  "routing": {
    // Directory containing routes
    "routesDir": string,             // default: "routes"
    
    // Trailing slash handling
    "trailingSlash": "always" | "never" | "preserve", // default: "preserve"
    
    // Route discovery strategy
    "discovery": "eager" | "lazy",   // default: "eager"
    
    // Route matching options
    "caseSensitive": boolean,        // default: false
    
    // Base path for routes
    "basePath": string               // default: "/"
  }
}
```

### Runtime Configuration

```typescript
{
  "runtime": {
    // Hot reload in development
    "hotReload": boolean,            // default: true in dev
    
    // File patterns to watch
    "watchGlobs": string[],          // default: ["**/*.{ts,js}"]
    
    // Dependency injection
    "dependencies": {
      "initial": Record<string, unknown>,
      "bootstrapModule": string,
      "merge": "shallow" | "deep" | "replace",
      "readonly": string[]
    },
    
    // Hypervisor configuration
    "hv": HypervisorConfig
  }
}
```

### Security Configuration

```typescript
{
  "security": {
    // CORS settings
    "cors": {
      "allowedOrigins": string[],
      "allowedHeaders": string[],
      "allowedMethods": string[],
      "allowCredentials": boolean,
      "maxAge": number
    },
    
    // Default security headers
    "defaultHeaders": Record<string, string>,
    
    // Headers to scrub from logs
    "scrubHeaders": string[]
  }
}
```

### Logging Configuration

```typescript
{
  "logging": {
    // Log level
    "level": "debug" | "info" | "warn" | "error",

    // Request ID header name
    "requestIdHeader": string,

    // Deno OpenTelemetry auto-instrumentation
    "otel": {
      "enabled": boolean,
      "serviceName": string,
      "endpoint": string, // e.g., http://localhost:4318
      "protocol": "http/protobuf" | "http/json",
      "headers": Record<string, string>,
      "resourceAttributes": Record<string, string>,
      "propagators": string, // e.g., "tracecontext,baggage"
      "metricExportIntervalMs": number,
      // Optional hooks for custom spans/metrics
      "hooks": {
        "onInit"?: (input: { tracer?: unknown; meter?: unknown }) => unknown | Promise<unknown>,
        "onRequestStart"?: (input: { tracer?: unknown; meter?: unknown; span?: unknown; requestId: string; method: string; url: string; project: string; state?: unknown }) => void | Promise<void>,
        "onRequestEnd"?: (input: { tracer?: unknown; meter?: unknown; span?: unknown; requestId: string; method: string; url: string; project: string; status: number; durationMs: number; state?: unknown }) => void | Promise<void>
      }
    }
  }
}
```

### Loaders Configuration

```typescript
{
  "loaders": {
    // Local file system loader
    "local": {
      "enabled": boolean             // default: true
    },
    
    // GitHub loader
    "github": {
      "enabled": boolean,            // default: false
      "tokenEnv": string,            // default: "GITHUB_TOKEN"
      "cacheTtlSec": number         // default: 300
    },
    
    // HTTP loader
    "http": {
      "enabled": boolean,            // default: false
      "timeout": number              // default: 30000
    }
  }
}
```

## Environment-Based Configuration

### Development Configuration

```json
{
  "server": {
    "port": 3000
  },
  "runtime": {
    "hotReload": true,
    "dependencies": {
      "initial": {
        "environment": "development",
        "debug": true
      }
    }
  },
  "logging": {
    "level": "debug",
    "format": "pretty"
  },
  "security": {
    "cors": {
      "allowedOrigins": ["http://localhost:3000", "http://localhost:3001"]
    }
  }
}
```

### Production Configuration

```json
{
  "server": {
    "port": 8080
  },
  "runtime": {
    "hotReload": false,
    "hv": {
      "enabled": true,
      "workers": "auto",
      "strategy": "least_busy",
      "autoscale": {
        "enabled": true,
        "min": 2,
        "max": 10
      }
    }
  },
  "logging": {
    "level": "warn",
    "format": "json"
  },
  "security": {
    "cors": {
      "allowedOrigins": ["https://myapp.com"]
    },
    "defaultHeaders": {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-xss-protection": "1; mode=block"
    }
  }
}
```

### Testing Configuration

```json
{
  "routing": {
    "routesDir": "test-routes"
  },
  "runtime": {
    "hotReload": false,
    "dependencies": {
      "initial": {
        "environment": "test"
      }
    }
  },
  "logging": {
    "level": "error"
  }
}
```

## Configuration Precedence

Oxian follows this configuration precedence (highest to lowest):

1. **Command-line arguments** - `--port=3000`
2. **Environment variables** - `OXIAN_PORT=3000`
3. **Configuration file** - `oxian.config.ts/js/json`
4. **Default values** - Built-in defaults

### Command-Line Arguments

```bash
# Override specific settings
deno run -A jsr:@oxian/oxian-js --port=3000 --config=custom.config.ts

# Environment-specific config
deno run -A jsr:@oxian/oxian-js --config=production.config.json
```

### Environment Variables

```bash
# Server settings
export OXIAN_PORT=8080
export OXIAN_HOST=0.0.0.0

# Runtime settings
export OXIAN_HOT_RELOAD=false
export OXIAN_LOG_LEVEL=debug

# Security settings
export OXIAN_CORS_ORIGINS="https://app.com,https://admin.app.com"

# Start server
deno run -A jsr:@oxian/oxian-js
```

## Advanced Configuration Patterns

### Multi-Environment Setup

```ts
// oxian.config.ts
const env = Deno.env.get("NODE_ENV") || "development";

const baseConfig = {
  routing: {
    routesDir: "routes",
  },
  logging: {
    requestIdHeader: "x-request-id",
  },
};

const envConfigs = {
  development: {
    server: { port: 3000 },
    runtime: { hotReload: true },
    logging: { level: "debug", format: "pretty" },
  },

  staging: {
    server: { port: 8080 },
    runtime: { hotReload: false },
    logging: { level: "info", format: "json" },
    security: {
      cors: {
        allowedOrigins: ["https://staging.myapp.com"],
      },
    },
  },

  production: {
    server: { port: 8080 },
    runtime: {
      hotReload: false,
      hv: {
        enabled: true,
        workers: "auto",
      },
    },
    logging: { level: "warn", format: "json" },
    security: {
      cors: {
        allowedOrigins: ["https://myapp.com"],
      },
      defaultHeaders: {
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-content-type-options": "nosniff",
      },
    },
  },
};

export default {
  ...baseConfig,
  ...envConfigs[env],
};
```

### Feature Flags Configuration

```ts
// oxian.config.ts
export default {
  runtime: {
    dependencies: {
      initial: {
        features: {
          newUserApi: Deno.env.get("FEATURE_NEW_USER_API") === "true",
          advancedMetrics: Deno.env.get("FEATURE_ADVANCED_METRICS") === "true",
          betaFeatures: Deno.env.get("FEATURE_BETA") === "true",
        },
      },
    },
  },
};
```

Usage in routes:

```ts
// routes/users.ts
export function GET(_, { dependencies }) {
  const { features } = dependencies;

  if (features.newUserApi) {
    return getUsersV2();
  } else {
    return getUsersV1();
  }
}
```

### Database Configuration

```ts
// oxian.config.ts
const dbConfig = {
  development: {
    type: "sqlite",
    url: "./dev.db",
  },
  test: {
    type: "sqlite",
    url: ":memory:",
  },
  production: {
    type: "postgresql",
    url: Deno.env.get("DATABASE_URL"),
    pool: {
      min: 5,
      max: 20,
    },
  },
};

export default {
  runtime: {
    dependencies: {
      initial: {
        database: dbConfig[Deno.env.get("NODE_ENV") || "development"],
      },
    },
  },
};
```

### Service Integration Configuration

```ts
// oxian.config.ts
export default {
  runtime: {
    dependencies: {
      initial: {
        services: {
          email: {
            provider: Deno.env.get("EMAIL_PROVIDER") || "console",
            apiKey: Deno.env.get("SENDGRID_API_KEY"),
            from: Deno.env.get("EMAIL_FROM") || "noreply@example.com",
          },
          storage: {
            provider: Deno.env.get("STORAGE_PROVIDER") || "local",
            bucket: Deno.env.get("S3_BUCKET"),
            region: Deno.env.get("S3_REGION"),
            accessKey: Deno.env.get("S3_ACCESS_KEY"),
            secretKey: Deno.env.get("S3_SECRET_KEY"),
          },
          monitoring: {
            enabled: Deno.env.get("MONITORING_ENABLED") === "true",
            apiKey: Deno.env.get("DATADOG_API_KEY"),
            service: "oxian-api",
          },
        },
      },
    },
  },
};
```

## Configuration Validation

### Runtime Validation

```ts
// oxian.config.ts
function validateConfig(config: any) {
  const required = ["server.port"];

  for (const path of required) {
    const value = path.split(".").reduce((obj, key) => obj?.[key], config);
    if (value === undefined) {
      throw new Error(`Required configuration missing: ${path}`);
    }
  }

  // Validate port range
  if (config.server?.port < 1 || config.server?.port > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }

  return config;
}

const config = {
  server: {
    port: parseInt(Deno.env.get("PORT") || "8080"),
  },
  // ... other config
};

export default validateConfig(config);
```

### Schema Validation with Zod

```ts
// oxian.config.ts
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const ConfigSchema = z.object({
  server: z.object({
    port: z.number().min(1).max(65535),
    hostname: z.string().optional(),
  }),
  runtime: z.object({
    hotReload: z.boolean().optional(),
    hv: z.object({
      enabled: z.boolean().optional(),
      workers: z.union([z.number(), z.literal("auto")]).optional(),
    }).optional(),
  }).optional(),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).optional(),
  }).optional(),
});

const rawConfig = {
  server: {
    port: parseInt(Deno.env.get("PORT") || "8080"),
  },
  // ... other config
};

export default ConfigSchema.parse(rawConfig);
```

## Configuration Best Practices

### ✅ Do

- Use environment variables for secrets and environment-specific values
- Validate configuration at startup
- Provide sensible defaults
- Use TypeScript for complex dynamic configuration
- Document configuration options
- Keep development and production configs similar
- Use feature flags for experimental features

### ❌ Don't

- Don't hardcode secrets in configuration files
- Don't ignore configuration validation errors
- Don't use overly complex configuration logic
- Don't forget to handle missing environment variables
- Don't commit sensitive configuration to version control

## Configuration Examples

### Microservice Configuration

```json
{
  "server": {
    "port": 8080
  },
  "routing": {
    "basePath": "/api/v1"
  },
  "runtime": {
    "hv": {
      "enabled": true,
      "workers": 4
    },
    "dependencies": {
      "initial": {
        "serviceName": "user-service",
        "version": "1.2.3"
      }
    }
  },
  "security": {
    "cors": {
      "allowedOrigins": ["https://api-gateway.com"]
    },
    "defaultHeaders": {
      "x-service-name": "user-service"
    }
  }
}
```

### API Gateway Configuration

```json
{
  "server": {
    "port": 80
  },
  "runtime": {
    "hv": {
      "enabled": true,
      "projects": {
        "users": {
          "routing": { "basePath": "/users" }
        },
        "orders": {
          "routing": { "basePath": "/orders" }
        },
        "admin": {
          "routing": { "basePath": "/admin" }
        }
      },
      "select": [
        {
          "project": "users",
          "when": { "pathPrefix": "/users" }
        },
        {
          "project": "orders",
          "when": { "pathPrefix": "/orders" }
        },
        {
          "project": "admin",
          "when": { "pathPrefix": "/admin" }
        }
      ]
    }
  }
}
```

## Environment Files

### .env Support

While Oxian doesn't automatically load `.env` files, you can load them manually:

```ts
// oxian.config.ts
import { load } from "https://deno.land/std@0.210.0/dotenv/mod.ts";

// Load .env file
const env = await load();

export default {
  server: {
    port: parseInt(env.PORT || "8080"),
  },
  runtime: {
    dependencies: {
      initial: {
        dbUrl: env.DATABASE_URL,
        apiKey: env.API_KEY,
      },
    },
  },
};
```

### Environment-specific .env files

```ts
// oxian.config.ts
import { load } from "https://deno.land/std@0.210.0/dotenv/mod.ts";

const nodeEnv = Deno.env.get("NODE_ENV") || "development";
const envFile = `.env.${nodeEnv}`;

let env = {};
try {
  env = await load({ envPath: envFile });
} catch {
  // Fallback to default .env
  env = await load();
}

export default {
  // Use loaded environment variables
  server: {
    port: parseInt(env.PORT || "8080"),
  },
};
```

---

Configuration in Oxian is designed to be flexible and powerful while maintaining
simplicity. Start with JSON for basic setups and move to TypeScript when you
need dynamic behavior.

**Next Steps:**

- [Deployment Guide](./deployment.md) - Deploy with proper configuration
- [Environment Variables](./environment.md) - Manage secrets and settings
- [Best Practices](./best-practices.md) - Configuration patterns and tips
