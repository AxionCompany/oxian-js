# 🚀 Hypervisor - Multi-Process Scaling

The Oxian Hypervisor is a powerful production feature that enables horizontal scaling by running multiple worker processes and load balancing requests between them. It's designed for high-traffic scenarios where you need better performance, fault isolation, and multi-tenancy.

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

## Multi-Project Support

The hypervisor supports hosting multiple projects/applications with intelligent routing. You can use either declarative selection rules or a single provider function.

### Project Configuration

```json
{
  "runtime": {
    "hv": {
      "projects": {
        "api": {
          "routing": {
            "basePath": "/api"
          }
        },
        "admin": {
          "routing": {
            "basePath": "/admin"
          }
        },
        "docs": {
          "routing": {
            "basePath": "/docs"
          }
        }
      },
      // Optional: provider (TypeScript config only)
      // Called once per request; returns project and per-worker overrides
      // Type: (input: { req: Request } | { project: string }) => Promise<{
      //   project: string; source?: string; config?: string; env?: Record<string,string>;
      //   githubToken?: string; stripPathPrefix?: string; isolated?: boolean
      // }> | { ... }
      "provider": "ts-only",
      // Or use declarative selection rules
      "select": [ { "project": "api", "when": { "pathPrefix": "/api" } }, { "default": true, "project": "api" } ]
    }
  }
}
```

### Per-project Web Configuration

You can configure per-project web behavior that overlays the global `hv.web`. The hypervisor first selects the project based on provider/rules, then:

1. Determines the effective API base path: `hv.projects[project].routing.basePath` → global `basePath` → `/`.
2. If the request path does not start with that base path, it applies the selected project’s `web` config (merged with global `hv.web`).

Available per-project `web` options:
- `devProxyTarget`: Proxy non-API paths to a dev server (e.g., `http://localhost:5173`).
- `staticDir`: Serve static files for non-API paths in production; falls back to `index.html` for SPA routes.
- `staticCacheControl`: Optional cache-control header for static asset responses.

Example:

```json
{
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
          "web": { "staticDir": "apps/b/dist", "staticCacheControl": "public, max-age=3600" }
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
- Requests matching a project’s API base path are proxied to that project’s worker.
- Other paths are handled by that project’s `web` config (dev proxy if set; otherwise static serving if `staticDir` is set; otherwise 404).

### Provider (Single Function)

Define a single function (only in TS/JS config) to both select the project and provide per-worker overrides.

```ts
// oxian.config.ts
export default ({}) => ({
  runtime: {
    hv: {
      projects: { local: {}, github: {} },
      provider: async ({ req }) => {
        const host = new URL(req.url).hostname;
        if (host === "0.0.0.0") {
          return {
            project: "github",
            source: "github:AcmeOrg/api?ref=main",
            env: { FEATURE_FLAG: "1" },
            githubToken: Deno.env.get("GITHUB_TOKEN") || undefined,
            isolated: true // optional per-worker DENO_DIR, with restricted write and read permissions to the project directory
          };
        }
        return { project: "local" };
      }
    }
  }
});
```

### Selection Rules

Route requests to different projects based on various criteria:

```json
{
  "select": [
    {
      "project": "api-v2",
      "when": {
        "pathPrefix": "/v2",
        "method": "GET"
      }
    },
    {
      "project": "admin",
      "when": {
        "hostEquals": "admin.example.com"
      }
    },
    {
      "project": "docs",
      "when": {
        "hostPrefix": "docs."
      }
    },
    {
      "project": "special",
      "when": {
        "header": {
          "x-api-version": "beta",
          "authorization": "Bearer .*"
        }
      }
    },
    {
      "project": "main",
      "default": true
    }
  ]
}
```

**Selection Criteria:**
- `pathPrefix` - Route based on URL path
- `hostEquals` - Exact hostname match
- `hostPrefix` - Hostname starts with
- `hostSuffix` - Hostname ends with
- `method` - HTTP method
- `header` - Header values (string or RegExp)
- `default` - Fallback project

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

Workers can be stopped automatically when idle (no active requests/streams) for a configured duration. This saves resources during quiet periods.

- Configure per project: `runtime.hv.projects[project].idleTtlMs` (ms)
- Provider override at spawn: `SelectedProject.idleTtlMs`
- Global fallback: `runtime.hv.autoscale.idleTtlMs`
- Default: disabled (no idle stop unless configured)

Semantics:
- Inflight increments when the hypervisor starts proxying a request and decrements only after the response body finishes streaming to the client. This ensures long‑lived Streaming/SSE requests keep the worker alive until the client closes.
- Last activity is updated on request start and completion; the idle timer compares current time to the last activity.
- When `idleTtlMs` elapses with inflight=0, the worker is stopped intentionally; it will not auto‑heal until a new request arrives (on‑demand spawn).

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

### Logging

The hypervisor provides structured logging:

```json
{
  "timestamp": "2024-01-20T10:30:00.000Z",
  "level": "info",
  "message": "[hv] proxy",
  "data": {
    "method": "GET",
    "url": "http://localhost:8080/api/users",
    "selected": "api",
    "target": "http://localhost:9101/users",
    "requestId": "req_abc123"
  }
}
```

Enable debug logging:

```bash
OXIAN_LOG_LEVEL=debug deno run -A jsr:@oxian/oxian-js
```

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
2. **Workers spawn** on sequential ports (9101, 9102, ...)
3. **Health checks** verify worker readiness
4. **Load balancer** starts routing requests

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
    timestamp: new Date().toISOString()
  };
}
```

### Worker-Specific Configuration

Different configs per worker:

```json
{
  "runtime": {
    "hv": {
      "projects": {
        "high-memory": {
          "worker": {
            "pool": { "max": 2 }
          }
        },
        "cpu-intensive": {
          "worker": {
            "pool": { "max": 8 }
          }
        }
      }
    }
  }
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
        "idleTtlMs": 180000,  // Scale down after 3 min idle
        "min": 1,             // Minimum workers
        "max": 16             // Maximum workers
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
        "connectMs": 1000,    // Fast connection timeout
        "headersMs": 5000,    // Header timeout
        "totalMs": 30000      // Total request timeout
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

```json
{
  "runtime": {
    "hv": {
      "projects": {
        "tenant-a": {
          "routing": { "basePath": "/tenant-a" }
        },
        "tenant-b": {
          "routing": { "basePath": "/tenant-b" }
        }
      },
      "select": [
        {
          "project": "tenant-a",
          "when": { "pathPrefix": "/tenant-a" }
        },
        {
          "project": "tenant-b", 
          "when": { "pathPrefix": "/tenant-b" }
        }
      ]
    }
  }
}
```

---

The hypervisor is a powerful tool for scaling Oxian applications. Start simple and gradually add complexity as your needs grow. For most applications, the default configuration provides excellent performance and reliability.

**Next Steps:**
- [Configuration Guide](./configuration.md)
- [Deployment Best Practices](./deployment.md)
- [Monitoring & Observability](./monitoring.md)
