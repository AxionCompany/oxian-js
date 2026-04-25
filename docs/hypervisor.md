# 🚀 Hypervisor - Multi-Process Scaling

The Oxian Hypervisor is a powerful production feature that enables horizontal
scaling by running multiple worker processes and load balancing requests between
them. It's designed for high-traffic scenarios where you need better
performance, fault isolation, and multi-tenancy.

## Overview

The hypervisor architecture consists of:

- **🎯 Main Process** - Acts as a reverse proxy and load balancer
- **⚡ Worker Processes** - Multiple Oxian instances running your routes
- **🔀 Request Router** - Intelligent request routing based on rules
- **💚 Health Monitoring** - Automatic health checks and worker management

```
┌─────────────────┐    ┌──────────────┐
│   Client        │────│  Hypervisor  │
│   Requests      │    │  (Port 8080) │
└─────────────────┘    └──────┬───────┘
                              │
                    ┌─────────┼─────────┐
                    │         │         │
              ┌─────▼───┐ ┌───▼───┐ ┌───▼───┐
              │Worker 1 │ │Worker 2│ │Worker N│
              │Port 9101│ │Port 9102│ │Port 910N│
              └─────────┘ └───────┘ └───────┘
```

## Quick Start

### Basic Hypervisor Setup

The hypervisor is enabled by default. To run with hypervisor:

```bash
# Run with hypervisor (default behavior)
deno run -A jsr:@oxian/oxian-js

# Explicitly enable hypervisor
deno run -A jsr:@oxian/oxian-js --hypervisor

# Disable hypervisor (single process)
deno run -A jsr:@oxian/oxian-js --hypervisor=false
```

### Configuration

Configure the hypervisor in `oxian.config.json`:

```json
{
  "runtime": {
    "hv": {
      "enabled": true,
      "workers": 4,
      "strategy": "round_robin",
      "workerBasePort": 9101,
      "proxy": {
        "timeoutMs": 30000,
        "passRequestId": true
      },
      "health": {
        "path": "/_health",
        "intervalMs": 5000,
        "timeoutMs": 2000
      }
    }
  }
}
```

## Configuration Options

### Core Settings

```typescript
{
  "runtime": {
    "hv": {
      // Enable/disable hypervisor
      "enabled": boolean,
      
      // Number of worker processes ("auto" = CPU cores)
      "workers": number | "auto",
      
      // Load balancing strategy
      "strategy": "round_robin" | "least_busy" | "sticky",
      
      // Header for sticky sessions (when strategy = "sticky")
      "stickyHeader": string,
      
      // Base port for workers (9101, 9102, etc.)
      "workerBasePort": number
    }
  }
}
```

### Proxy Settings

```typescript
{
  "runtime": {
    "hv": {
      "proxy": {
        // Request timeout to workers
        "timeoutMs": 30000,
        
        // Forward request ID to workers
        "passRequestId": true
      },
      
      // Request-level timeouts
      "timeouts": {
        "connectMs": 5000,
        "headersMs": 10000,
        "idleMs": 30000,
        "totalMs": 60000
      }
    }
  }
}
```

### Health Monitoring

```typescript
{
  "runtime": {
    "hv": {
      "health": {
        // Health check endpoint
        "path": "/_health",
        
        // Check interval
        "intervalMs": 5000,
        
        // Health check timeout
        "timeoutMs": 2000
      }
    }
  }
}
```

## Multi-Service Support

The hypervisor supports hosting multiple services/applications with dynamic
routing via a single **provider** function.

### Provider

The provider is a function (TypeScript config only) that receives a `Request`
and returns a `ServiceDefinition` — everything the hypervisor needs to route
and spawn a worker for that request.

```ts
// oxian.config.ts
export default {
  runtime: {
    hv: {
      provider: async (req) => {
        const host = new URL(req.url).hostname;
        if (host === "api.example.com") {
          return {
            service: "api",
            source: "github:AcmeOrg/api?ref=main",
            env: { FEATURE_FLAG: "1" },
            auth: { GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN") || "" },
            isolated: true,
          };
        }
        return { service: "default" };
      },
    },
  },
};
```

When no provider is configured, the hypervisor defaults to
`() => ({ service: "default" })`.

### ServiceDefinition

The provider returns a `ServiceDefinition` with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `service` | `string` | **Required.** Unique service identifier |
| `source` | `string` | Source URL (`file://`, `github:`, `https:`) |
| `config` | `string` | Per-service config path/URL |
| `auth` | `Record<string, string>` | Auth tokens (e.g., `{ GITHUB_TOKEN: "..." }`) |
| `permissions` | `PermissionSet` | Deno permission overrides |
| `materialize` | `boolean \| MaterializeOpts` | Download/extract remote source |
| `env` | `Record<string, string>` | Environment variables for the worker |
| `isolated` | `boolean` | Run in `./.services/<service>` with restricted permissions |
| `stripPathPrefix` | `string` | Strip URL prefix before proxying |
| `invalidateCacheAt` | `string \| number \| Date` | Force worker reload after this timestamp |
| `idleTtlMs` | `number` | Idle timeout before stopping the worker |
| `denoConfig` | `string` | Path to deno.json for the worker |

### Web Configuration (preferred top-level)

Preferred: set `web` at the configuration top level (`config.web`) so workers
(which actually serve static/dev proxy) read it directly. For backward
compatibility, `runtime.hv.web` is still supported and used as a fallback.

Available `web` options:

- `devProxyTarget`: Proxy non-API paths to a dev server (e.g.,
  `http://localhost:5173`).
- `staticDir`: Serve static files for non-API paths in production; falls back to
  `index.html` for SPA routes.
- `staticCacheControl`: Optional cache-control header for static asset
  responses.

### Provider Examples

**Path-based routing:**

```ts
provider: (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/v2")) {
    return { service: "api-v2", stripPathPrefix: "/api/v2" };
  }
  if (url.pathname.startsWith("/admin")) {
    return { service: "admin", stripPathPrefix: "/admin" };
  }
  return { service: "main" };
}
```

**Host-based routing:**

```ts
provider: (req) => {
  const host = new URL(req.url).hostname;
  if (host.startsWith("admin.")) return { service: "admin" };
  if (host.startsWith("docs.")) return { service: "docs" };
  return { service: "main" };
}
```

**Header-based routing:**

```ts
provider: (req) => {
  const version = req.headers.get("x-api-version");
  if (version === "beta") return { service: "api-beta" };
  return { service: "api" };
}
```

**Database-backed routing (multi-tenant):**

```ts
provider: async (req) => {
  const tenantId = req.headers.get("x-tenant-id");
  const tenant = await db.query("SELECT * FROM tenants WHERE id = ?", [tenantId]);
  return {
    service: `tenant-${tenantId}`,
    source: tenant.sourceUrl,
    config: tenant.configUrl,
    isolated: true,
    idleTtlMs: 300000,
  };
}
```

## Load Balancing Strategies

### Round Robin (Default)

Distributes requests evenly across workers:

```json
{
  "runtime": {
    "hv": {
      "strategy": "round_robin"
    }
  }
}
```

Perfect for:

- ✅ Stateless applications
- ✅ Even load distribution
- ✅ Simple setup

### Sticky Sessions

Routes requests from the same client to the same worker:

```json
{
  "runtime": {
    "hv": {
      "strategy": "sticky",
      "stickyHeader": "x-session-id"
    }
  }
}
```

Perfect for:

- ✅ Session-based applications
- ✅ WebSocket connections
- ✅ Stateful services

### Least Busy

Routes to the worker with fewest active connections:

```json
{
  "runtime": {
    "hv": {
      "strategy": "least_busy"
    }
  }
}
```

Perfect for:

- ✅ Variable request processing times
- ✅ Optimal resource utilization
- ✅ High-performance scenarios

## Auto-Scaling

Configure automatic scaling based on load:

```json
{
  "runtime": {
    "hv": {
      "autoscale": {
        "enabled": true,
        "min": 2,
        "max": 10,
        "targetInflightPerWorker": 10,
        "maxAvgLatencyMs": 100,
        "scaleUpCooldownMs": 30000,
        "scaleDownCooldownMs": 60000,
        "idleTtlMs": 300000
      }
    }
  }
}
```

### Idle Shutdown

Workers can be stopped automatically when idle (no active requests/streams) for
a configured duration. This saves resources during quiet periods.

- Provider override at spawn: `ServiceDefinition.idleTtlMs`
- Global fallback: `runtime.hv.autoscale.idleTtlMs`
- Default: disabled (no idle stop unless configured)

Semantics:

- Inflight increments when the hypervisor starts proxying a request and
  decrements only after the response body finishes streaming to the client. This
  ensures long‑lived Streaming/SSE requests keep the worker alive until the
  client closes.
- Last activity is updated on request start and completion; the idle timer
  compares current time to the last activity.
- When `idleTtlMs` elapses with inflight=0, the worker is stopped intentionally;
  it will not auto‑heal until a new request arrives (on‑demand spawn).

Example:

```ts
{
  runtime: {
    hv: {
      autoscale: { idleTtlMs: 300000 },
      provider: (req) => ({
        service: "api",
        idleTtlMs: 120000, // per-service override
      }),
    },
  },
}
```

**Auto-scaling Triggers:**

- **Load-based** - Scale up when `targetInflightPerWorker` exceeded
- **Latency-based** - Scale up when `maxAvgLatencyMs` exceeded
- **Time-based** - Scale down after `idleTtlMs` idle time

## Development vs Production

### Development Mode

```bash
# Development with hypervisor
deno run -A jsr:@oxian/oxian-js dev

# Development without hypervisor (faster startup)
deno run -A jsr:@oxian/oxian-js dev --hypervisor=false
```

Development config:

```json
{
  "runtime": {
    "hv": {
      "workers": 2,
      "strategy": "round_robin"
    }
  }
}
```

### Production Mode

```bash
# Production with optimized hypervisor
deno run -A jsr:@oxian/oxian-js start
```

Production config:

```json
{
  "runtime": {
    "hv": {
      "workers": "auto",
      "strategy": "least_busy",
      "autoscale": {
        "enabled": true,
        "min": 4,
        "max": 20
      },
      "health": {
        "intervalMs": 2000
      }
    }
  }
}
```

## Monitoring & Observability

### Health Checks

Workers expose health endpoints:

```bash
# Check main hypervisor
curl http://localhost:8080/_health

# Check individual worker
curl http://localhost:9101/_health
```

### OpenTelemetry

Oxian leverages Deno’s OpenTelemetry integration. Each incoming request creates
a span; standard attributes are set automatically, and Oxian adds `http.route`
and `oxian.service` when the route is known. Metrics are exported for request
duration, active requests, and body sizes. `console.*` output is exported as
OTLP logs.

For local development you can run a minimal built-in OTLP HTTP proxy inside
the hypervisor and choose per-request whether to forward or drop:

```ts
export default {
  logging: { otel: { enabled: true, serviceName: "oxian-server" } },
  runtime: {
    hv: {
      otelProxy: {
        enabled: true,
        port: 4318,
        pathPrefix: "/v1",
        upstream: Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
        onRequest: async ({ req, service, kind, contentType }) => {
          // `req` is safe to read here; original body is streamed to upstream
          if ((contentType || "").includes("json")) {
            const text = await req.text();
            console.log("[otel] sample", { kind, size: text.length });
          }
          return ["default", "billing"].includes(service || "default");
        },
      },
    },
  },
};
```

Notes:

- When `logging.otel.enabled` is true and no `endpoint` is provided, workers
  default to the built-in proxy (`http://127.0.0.1:<port>`).
- The hypervisor injects `x-oxian-service: <service>` into OTLP headers for tagging.
- If `upstream` is not specified or `onRequest` returns false, the proxy responds 202 and drops the payload.
- For custom spans/metrics per request, define `logging.otel.hooks` (see
  instrumentation.md). Hooks receive the active span and a meter instance.

### Metrics

Monitor key metrics:

- **Request Rate** - Requests per second per worker
- **Response Time** - Average latency per worker
- **Error Rate** - Error percentage per worker
- **Active Connections** - Current connections per worker
- **Health Status** - Worker availability

## Worker Lifecycle

### Startup Process

1. **Hypervisor starts** on main port (8080)
2. **First request arrives** — the provider returns a `ServiceDefinition`
3. If the service requires materialization:
   - Run `materialize` once to download/extract remote source to the worker cwd
     (isolated → `./.services/<service>`)
   - Run `prepare` to execute `prepare` hooks defined in the materialized
     `oxian.config.*`
4. **Worker spawns** on a sequential port (9101, 9102, ...) with `--source`
   pointing to the materialized `file://` root
5. **Health checks** verify worker readiness
6. **Load balancer** starts routing requests

### Worker Health

Workers are considered healthy when:

- ✅ Process is running
- ✅ Health endpoint responds (200 OK)
- ✅ Response time < timeout threshold

### Graceful Shutdown

1. **SIGTERM** sent to hypervisor
2. **Stop accepting** new requests
3. **Drain** existing requests
4. **Shutdown workers** gracefully
5. **Close** all connections

## Custom Plugins

The hypervisor delegates lifecycle actions to a **plugin**. The default
`OxianPlugin` spawns local Deno subprocesses, but you can provide your own
plugin for external platforms (Cloud Run, K8s, etc.).

```ts
import type { HypervisorPlugin, SpawnResult } from "oxian-js/hypervisor";

class CloudRunPlugin implements HypervisorPlugin {
  async spawn(service, ctx, opts): Promise<SpawnResult> {
    // Deploy a Cloud Run service
    const url = await deployToCloudRun(service);
    return { target: url };
  }

  async stop(handle: unknown): Promise<void> {
    // Tear down the Cloud Run service
  }

  async checkReady(target: string, opts): Promise<boolean> {
    // Poll the Cloud Run URL for readiness
    const r = await fetch(`${target}/_health`);
    return r.ok;
  }
}
```

### Plugin Interface

| Method | Description |
|--------|-------------|
| `spawn(service, ctx, opts)` | Spawn a worker, return `{ target, handle?, owner? }` |
| `stop(handle)` | Stop a previously spawned worker |
| `checkReady(target, opts)` | Check if a target URL is ready |
| `transformProxyHeaders?(headers, req, service)` | Optional header transformation |

### External Targets

If the provider returns a `ServiceDefinition` with a `target` field, the
hypervisor proxies directly to that URL without spawning:

```ts
provider: (req) => ({
  service: "external-api",
  target: "https://api.example.com",
})
```

## Pluggable Store

All hypervisor state (pool targets, locks, counters, activity timestamps)
goes through a `HypervisorStore` interface. The default `MemoryStore` wraps
in-memory Maps for zero-overhead single-instance use.

For distributed multi-instance deployments, provide a custom store backed
by Redis or similar:

```ts
import { startHypervisor, MemoryStore } from "oxian-js/hypervisor";
import type { HypervisorStore } from "oxian-js/hypervisor";

// Default — just works:
await startHypervisor({ config, baseArgs }, plugin);

// Custom store for distributed deployment:
await startHypervisor({ config, baseArgs }, plugin, myRedisStore);
```

### Store Interface

| Method | Description |
|--------|-------------|
| `get(key)` | Get a value by key |
| `set(key, value, ttlMs?)` | Set a value with optional TTL |
| `delete(key)` | Delete a key |
| `increment(key)` | Atomic increment, returns new value |
| `decrement(key)` | Atomic decrement (clamped to 0) |
| `acquire(key, ttlMs)` | Acquire a distributed lock |
| `release(key)` | Release a lock |
| `enqueue(queue, item)` | Enqueue an item, returns correlation ID |
| `drain(queue)` | Pop all pending items |
| `waitFor(id, timeoutMs?)` | Block until resolved |
| `resolve(id, value)` | Resolve a pending waitFor |

### Cross-Instance Forwarding

When running multiple hypervisor instances, requests can be forwarded
between instances via the `x-oxian-forward` header. An instance receiving
a request with this header skips the provider and routes directly to the
named service if it's running locally.

## Request Transformation

Transform requests before they reach workers using the `onRequest` callback
(TypeScript config only):

```ts
// oxian.config.ts
export default {
  runtime: {
    hv: {
      onRequest: ({ req, service }) => {
        // Modify requests before proxying to workers
        const headers = new Headers(req.headers);

        // Add custom headers
        headers.set("x-processed-by", "hypervisor");
        headers.set("x-service", service);
        headers.set("x-timestamp", Date.now().toString());

        // Add authentication token from environment
        const token = Deno.env.get(`${service.toUpperCase()}_API_TOKEN`);
        if (token) {
          headers.set("authorization", `Bearer ${token}`);
        }

        return new Request(req, { headers });
      },
    },
  },
};
```

### Common Use Cases

**Add Authentication Tokens:**

```ts
onRequest: (({ req, service }) => {
  const headers = new Headers(req.headers);
  const token = Deno.env.get(`${service.toUpperCase()}_TOKEN`);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(req, { headers });
});
```

**Request Auditing:**

```ts
onRequest: (async ({ req, service }) => {
  console.log(`[audit] ${service}: ${req.method} ${req.url}`);
  const headers = new Headers(req.headers);
  headers.set("x-audit-id", crypto.randomUUID());
  return new Request(req, { headers });
});
```

**URL Transformation:**

```ts
onRequest: (({ req, service }) => {
  const url = new URL(req.url);
  url.searchParams.set("source", "hypervisor");
  url.searchParams.set("service", service);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
});
```

**Error Handling:**

- If `onRequest` throws an error, the hypervisor returns a 500 response
- The request is not forwarded to workers
- Error is logged automatically

## Advanced Patterns

### Custom Health Checks

Implement custom health logic:

```ts
// routes/_health.ts
export function GET(_, { dependencies }) {
  const { db, redis } = dependencies;

  // Check dependencies
  const dbOk = await db.ping();
  const redisOk = await redis.ping();

  if (!dbOk || !redisOk) {
    throw { statusCode: 503, message: "Dependencies unavailable" };
  }

  return {
    status: "healthy",
    dependencies: { db: dbOk, redis: redisOk },
    timestamp: new Date().toISOString(),
  };
}
```

### Worker-Specific Configuration

The provider can return different configurations per service:

```ts
provider: (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/heavy")) {
    return { service: "high-memory", permissions: { read: true, write: "/tmp" } };
  }
  return { service: "default" };
}
```

### Request Context Forwarding

Forward context between hypervisor and workers:

```json
{
  "runtime": {
    "hv": {
      "proxy": {
        "passRequestId": true,
        "forwardHeaders": [
          "x-correlation-id",
          "x-user-id",
          "x-tenant-id"
        ]
      }
    }
  }
}
```

## Performance Tuning

### Worker Count

```bash
# Check CPU cores
nproc

# Set worker count
{
  "runtime": {
    "hv": {
      "workers": 8  // Usually CPU cores * 1-2
    }
  }
}
```

### Memory Optimization

```json
{
  "runtime": {
    "hv": {
      "autoscale": {
        "idleTtlMs": 180000, // Scale down after 3 min idle
        "min": 1, // Minimum workers
        "max": 16 // Maximum workers
      }
    }
  }
}
```

### Network Optimization

```json
{
  "runtime": {
    "hv": {
      "timeouts": {
        "connectMs": 1000, // Fast connection timeout
        "headersMs": 5000, // Header timeout
        "totalMs": 30000 // Total request timeout
      }
    }
  }
}
```

## Troubleshooting

### Common Issues

**Workers not starting:**

```bash
# Check port availability
netstat -tlnp | grep 910

# Check worker logs
OXIAN_LOG_LEVEL=debug deno run -A jsr:@oxian/oxian-js
```

**High latency:**

```bash
# Increase worker count
{
  "runtime": {
    "hv": {
      "workers": 16
    }
  }
}
```

**Memory issues:**

```bash
# Enable auto-scaling
{
  "runtime": {
    "hv": {
      "autoscale": {
        "enabled": true,
        "max": 4
      }
    }
  }
}
```

### Debug Commands

```bash
# List all processes
ps aux | grep deno

# Check port usage
lsof -i :8080
lsof -i :9101

# Monitor hypervisor
curl -s http://localhost:8080/_health | jq

# Check worker directly
curl -s http://localhost:9101/_health | jq
```

## Best Practices

### ✅ Do

- Use hypervisor for production deployments
- Monitor worker health and metrics
- Configure appropriate timeouts
- Enable auto-scaling for variable load
- Use sticky sessions for stateful apps
- Set up proper logging and monitoring

### ❌ Don't

- Don't use hypervisor for simple development
- Don't set too many workers on small instances
- Don't forget to configure health checks
- Don't ignore worker failures
- Don't mix stateful and stateless workers

## Examples

### High-Traffic API

```json
{
  "runtime": {
    "hv": {
      "enabled": true,
      "workers": "auto",
      "strategy": "least_busy",
      "autoscale": {
        "enabled": true,
        "min": 4,
        "max": 20,
        "targetInflightPerWorker": 50
      },
      "health": {
        "intervalMs": 1000
      }
    }
  }
}
```

### Multi-Tenant SaaS

```ts
{
  runtime: {
    hv: {
      provider: (req) => {
        const url = new URL(req.url);
        if (url.pathname.startsWith("/tenant-a")) {
          return { service: "tenant-a", stripPathPrefix: "/tenant-a" };
        }
        if (url.pathname.startsWith("/tenant-b")) {
          return { service: "tenant-b", stripPathPrefix: "/tenant-b" };
        }
        return { service: "default" };
      },
    },
  },
}
```

---

The hypervisor is a powerful tool for scaling Oxian applications. Start simple
and gradually add complexity as your needs grow. For most applications, the
default configuration provides excellent performance and reliability.

**Next Steps:**

- [Configuration Guide](./configuration.md)
- [Deployment Best Practices](./deployment.md)
- [Monitoring & Observability](./monitoring.md)
