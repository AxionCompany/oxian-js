# 🔄 Loaders - Local & Remote Execution

Oxian's loader architecture enables running APIs from various sources without build steps. Load code from local files, GitHub repositories, HTTP URLs, or other custom sources. This makes Oxian perfect for rapid prototyping, documentation examples, and distributed microservices.

## Overview

Oxian loaders:

- **🚀 Zero-build** - Run TypeScript/JavaScript directly
- **🔄 Dynamic loading** - Code is loaded and bundled at runtime
- **🌐 Multiple sources** - Local files, GitHub, HTTP, custom loaders
- **⚡ Caching** - Intelligent caching for performance
- **🔥 Hot reload** - Automatic reloading in development

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Request       │    │   Router     │    │   Loader        │
│   /api/users    │───▶│   Resolver   │───▶│   GitHub/Local  │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │                       │
                              ▼                       ▼
                       ┌──────────────┐    ┌─────────────────┐
                       │   Bundle &   │◀───│   Source Code   │
                       │   Execute    │    │   routes/users  │
                       └──────────────┘    └─────────────────┘
```

## Local Loader

The local loader reads files from your local file system.

### Basic Usage

```bash
# Run from current directory (default)
deno run -A jsr:@oxian/oxian-js

# Run from specific directory
deno run -A jsr:@oxian/oxian-js --config=./my-api/oxian.config.json
```

### Configuration

```json
{
  "loaders": {
    "local": {
      "enabled": true
    }
  },
  "root": "./my-api",
  "routing": {
    "routesDir": "routes"
  }
}
```

### File Watching

Local loader supports hot reload in development:

```json
{
  "runtime": {
    "hotReload": true,
    "watchGlobs": [
      "**/*.{ts,js}",
      "**/*.json",
      "**/dependencies.ts",
      "**/middleware.ts",
      "**/interceptors.ts"
    ]
  }
}
```

### Example Local Structure

```
my-api/
├── oxian.config.json
├── routes/
│   ├── index.ts
│   ├── users/
│   │   ├── index.ts
│   │   └── [id].ts
│   └── dependencies.ts
└── utils/
    └── database.ts
```

## GitHub Loader

Run APIs directly from GitHub repositories without cloning.

### Basic Usage

```bash
# Run from GitHub repo
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo

# Specific branch/tag
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=main

# Subdirectory in repo
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo/api

# Branch + subdirectory
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo/api?ref=v1.0
```

### GitHub URL Formats

```bash
# Short format
github:owner/repo
github:owner/repo/path
github:owner/repo?ref=branch
github:owner/repo/path?ref=tag

# Full URL format
https://github.com/owner/repo
https://github.com/owner/repo/tree/main/api
```

### Authentication

For private repositories, set your GitHub token:

```bash
# Set token
export GITHUB_TOKEN=ghp_your_token_here

# Run from private repo
deno run -A jsr:@oxian/oxian-js --source=github:private-org/private-repo
```

### Configuration

```json
{
  "loaders": {
    "github": {
      "enabled": true,
      "tokenEnv": "GITHUB_TOKEN",
      "cacheTtlSec": 300
    }
  }
}
```

### Example GitHub Repository

```
https://github.com/myorg/my-api/
├── routes/
│   ├── index.ts
│   ├── users/
│   │   ├── index.ts
│   │   └── [id].ts
│   └── dependencies.ts
├── oxian.config.json
└── README.md
```

Run it directly:

```bash
deno run -A jsr:@oxian/oxian-js --source=github:myorg/my-api
```

## HTTP Loader

Load APIs from any HTTP URL serving source code.

### Basic Usage

```bash
# Run from HTTP URL
deno run -A jsr:@oxian/oxian-js --source=https://example.com/api

# With specific configuration
deno run -A jsr:@oxian/oxian-js --source=https://api-server.com/source
```

### Configuration

```json
{
  "loaders": {
    "http": {
      "enabled": true,
      "timeout": 30000,
      "retries": 3,
      "headers": {
        "authorization": "Bearer token",
        "user-agent": "Oxian-Loader/1.0"
      }
    }
  }
}
```

### HTTP Loader Protocol

The HTTP loader expects a simple protocol:

```bash
# List directory contents
GET /routes/
→ ["index.ts", "users/", "posts.ts"]

# Get file contents
GET /routes/index.ts
→ export function GET() { return { hello: "world" }; }

# Get file info (optional)
HEAD /routes/index.ts
→ Headers: content-length, last-modified, content-type
```

## Caching

Loaders implement intelligent caching for performance.

### Local Caching

Local files use file system timestamps:

```ts
// Cache key: file path + mtime
const cacheKey = `${filePath}:${stat.mtime.getTime()}`;
```

### GitHub Caching

GitHub loader caches based on commit SHA:

```ts
// Cache key: repo + path + commit SHA
const cacheKey = `github:${owner}/${repo}/${path}:${commitSha}`;
```

### Cache Configuration

```json
{
  "loaders": {
    "github": {
      "cacheTtlSec": 300,        // 5 minutes
      "cacheDir": ".oxian-cache" // Local cache directory
    },
    "http": {
      "cacheTtlSec": 60,         // 1 minute
      "respectCacheHeaders": true // Use HTTP cache headers
    }
  }
}
```

### Manual Cache Control

```bash
# Clear all caches
deno run -A jsr:@oxian/oxian-js --clear-cache

# Force reload (ignore cache)
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo --no-cache
```

## Development Workflow

### Local Development

```bash
# Start with hot reload
deno run -A jsr:@oxian/oxian-js dev

# Auto-restart on changes
deno run -A jsr:@oxian/oxian-js dev --watch
```

### GitHub Development Workflow

```bash
# Work on feature branch
git checkout -b feature/new-api
# ... make changes ...
git push origin feature/new-api

# Test feature branch
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=feature/new-api

# Deploy to staging
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=staging

# Deploy to production
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=main
```

### Multi-Environment Setup

```bash
# Development
export API_SOURCE=github:myorg/api?ref=develop
deno run -A jsr:@oxian/oxian-js --source=$API_SOURCE

# Staging  
export API_SOURCE=github:myorg/api?ref=staging
deno run -A jsr:@oxian/oxian-js --source=$API_SOURCE

# Production
export API_SOURCE=github:myorg/api?ref=v1.2.3
deno run -A jsr:@oxian/oxian-js --source=$API_SOURCE
```

## Advanced Loader Usage

### Version Pinning

```bash
# Pin to specific commit
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=abc123

# Pin to tag
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=v1.2.3

# Pin to branch
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo?ref=release/1.x
```

### Monorepo Support

```bash
# API service in monorepo
deno run -A jsr:@oxian/oxian-js --source=github:myorg/monorepo/services/api

# Different services
deno run -A jsr:@oxian/oxian-js --source=github:myorg/monorepo/services/users
deno run -A jsr:@oxian/oxian-js --source=github:myorg/monorepo/services/orders
```

### Configuration Override

```bash
# Use remote source with local config
deno run -A jsr:@oxian/oxian-js \
  --source=github:owner/repo \
  --config=./local.config.json
```

### Custom Base Path

```json
{
  "basePath": "/api/v1",
  "loaders": {
    "github": {
      "enabled": true,
      "defaultRef": "main"
    }
  }
}
```

## Custom Loaders

Create custom loaders for specialized sources.

### Loader Interface

```ts
export interface Loader {
  scheme: string;
  canHandle: (url: URL) => boolean;
  load: (url: URL) => Promise<{ content: string; mediaType: LoaderMediaType }>;
  listDir?: (url: URL) => Promise<string[]>;
  stat?: (url: URL) => Promise<{ isFile: boolean; mtime?: number }>;
  cacheKey?: (url: URL) => string;
}
```

### Example S3 Loader

```ts
// loaders/s3.ts
import { S3Client } from "https://deno.land/x/s3_lite_client@0.7.0/mod.ts";

export class S3Loader implements Loader {
  scheme = "s3";
  
  constructor(private s3: S3Client) {}
  
  canHandle(url: URL): boolean {
    return url.protocol === "s3:";
  }
  
  async load(url: URL) {
    // s3://bucket/path/to/file.ts
    const bucket = url.hostname;
    const key = url.pathname.slice(1);
    
    try {
      const object = await this.s3.getObject(bucket, key);
      const content = await object.text();
      
      return {
        content,
        mediaType: key.endsWith(".ts") ? "ts" : "js"
      };
    } catch (error) {
      throw new Error(`Failed to load from S3: ${error.message}`);
    }
  }
  
  async listDir(url: URL): Promise<string[]> {
    const bucket = url.hostname;
    const prefix = url.pathname.slice(1);
    
    const objects = await this.s3.listObjects(bucket, { prefix });
    return objects.map(obj => obj.key);
  }
  
  cacheKey(url: URL): string {
    return `s3:${url.hostname}${url.pathname}`;
  }
}
```

### Register Custom Loader

```ts
// oxian.config.ts
import { S3Loader } from "./loaders/s3.ts";

export default {
  runtime: {
    customLoaders: [
      new S3Loader(createS3Client())
    ]
  }
};
```

## Use Cases & Examples

### Documentation Examples

Run live documentation examples:

```bash
# Run example from docs
deno run -A jsr:@oxian/oxian-js --source=github:oxian-org/examples/basic-crud

# Tutorial examples
deno run -A jsr:@oxian/oxian-js --source=github:oxian-org/tutorials/getting-started
```

### Microservices

Deploy microservices from different repositories:

```bash
# User service
deno run -A jsr:@oxian/oxian-js --source=github:myorg/user-service --port=8001

# Order service  
deno run -A jsr:@oxian/oxian-js --source=github:myorg/order-service --port=8002

# Notification service
deno run -A jsr:@oxian/oxian-js --source=github:myorg/notification-service --port=8003
```

### Feature Branches

Test features before merging:

```bash
# Test PR branch
deno run -A jsr:@oxian/oxian-js --source=github:myorg/api?ref=feature/user-auth

# Test different implementations
deno run -A jsr:@oxian/oxian-js --source=github:myorg/api?ref=experiment/new-db
```

### Multi-Tenant SaaS

Run different versions for different tenants:

```bash
# Tenant A (stable)
deno run -A jsr:@oxian/oxian-js --source=github:myorg/saas?ref=v1.0 --port=8080

# Tenant B (beta features)
deno run -A jsr:@oxian/oxian-js --source=github:myorg/saas?ref=v2.0-beta --port=8081
```

### CI/CD Pipeline

```yaml
# .github/workflows/deploy.yml
name: Deploy API
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Production
        run: |
          # Deploy directly from GitHub
          deno run -A jsr:@oxian/oxian-js \
            --source=github:${{ github.repository }}?ref=${{ github.sha }} \
            --port=8080
```

## Performance Considerations

### Bundle Caching

Oxian caches compiled bundles:

```ts
// Cache structure
.oxian-cache/
├── bundles/
│   ├── github-owner-repo-abc123/
│   │   ├── routes-index.js
│   │   └── routes-users-[id].js
└── metadata/
    └── github-owner-repo-abc123.json
```

### Cache Warming

Pre-warm cache for better performance:

```bash
# Warm cache for production deployment
deno run -A jsr:@oxian/oxian-js \
  --source=github:owner/repo \
  --warm-cache \
  --exit-after-warm
```

### Network Optimization

```json
{
  "loaders": {
    "github": {
      "cacheTtlSec": 3600,     // Longer cache for production
      "maxConcurrent": 10,     // Parallel downloads
      "timeout": 30000         // Request timeout
    }
  }
}
```

## Troubleshooting

### Common Issues

**GitHub rate limiting:**
```bash
# Set token to increase rate limits
export GITHUB_TOKEN=ghp_your_token_here
```

**Network timeouts:**
```json
{
  "loaders": {
    "github": {
      "timeout": 60000,
      "retries": 3
    }
  }
}
```

**Cache issues:**
```bash
# Clear cache
rm -rf .oxian-cache

# Disable cache
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo --no-cache
```

### Debug Mode

```bash
# Enable loader debugging
OXIAN_DEBUG_LOADERS=true deno run -A jsr:@oxian/oxian-js --source=github:owner/repo
```

### Manual Cache Management

```ts
// Clear specific cache
await clearCache("github:owner/repo");

// Get cache stats
const stats = await getCacheStats();
console.log(stats);
```

## Best Practices

### ✅ Do

- Use version pinning for production deployments
- Set up proper GitHub token for private repos
- Configure appropriate cache TTL for your use case
- Use hot reload for local development
- Test with different branches before merging
- Monitor cache hit rates in production

### ❌ Don't

- Don't rely on `main` branch for production (use tags)
- Don't forget to set GitHub token for private repos
- Don't ignore network timeouts in production
- Don't disable caching in production
- Don't commit sensitive tokens to repositories

## Security Considerations

### Access Control

```json
{
  "loaders": {
    "github": {
      "allowedRepos": [
        "myorg/api",
        "myorg/shared-utils"
      ]
    },
    "http": {
      "allowedHosts": [
        "api.mycompany.com",
        "internal.mycompany.com"
      ]
    }
  }
}
```

### Token Security

```bash
# Use environment variables
export GITHUB_TOKEN=ghp_token_here

# Or use secret management
export GITHUB_TOKEN=$(vault kv get -field=token secret/github)
```

---

Loaders make Oxian incredibly flexible for modern deployment scenarios. Start with local development, then leverage GitHub and HTTP loaders for powerful deployment patterns.

**Next Steps:**
- [Deployment Guide](./deployment.md) - Production deployment strategies
- [Configuration](./configuration.md) - Advanced configuration options
- [Best Practices](./best-practices.md) - Production-ready patterns
