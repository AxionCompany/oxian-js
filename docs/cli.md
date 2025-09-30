# 🖥️ CLI - Command Line Interface

The Oxian CLI provides powerful commands for development, deployment, and maintenance. This guide covers all CLI features, from basic usage to advanced automation scripts.

## Installation & Basic Usage

### Running Oxian

No installation required - run directly with Deno:

```bash
# Run from current directory
deno run -A jsr:@oxian/oxian-js

# Run with specific source
deno run -A jsr:@oxian/oxian-js --source=github:owner/repo

# Run with custom configuration
deno run -A jsr:@oxian/oxian-js --config=custom.config.json
```

### Help System

```bash
# Show help
deno run -A jsr:@oxian/oxian-js --help

# Command-specific help
deno run -A jsr:@oxian/oxian-js routes --help
```

## Core Commands

### `start` - Start Server

Start the Oxian server (default command):

```bash
# Start with defaults
deno run -A jsr:@oxian/oxian-js start

# Custom port
deno run -A jsr:@oxian/oxian-js start --port=3000

# With hypervisor
deno run -A jsr:@oxian/oxian-js start --hypervisor

# Without hypervisor
deno run -A jsr:@oxian/oxian-js start --hypervisor=false

# Custom configuration
deno run -A jsr:@oxian/oxian-js start --config=production.config.json
```

### `dev` - Development Server

Start with development features enabled:

```bash
# Development mode (hot reload enabled)
deno run -A jsr:@oxian/oxian-js dev

# Custom port
deno run -A jsr:@oxian/oxian-js dev --port=3000

# Watch specific files
deno run -A jsr:@oxian/oxian-js dev --watch="**/*.{ts,js,json}"

# Debug mode
deno run -A jsr:@oxian/oxian-js dev --debug

# Without hot reload
deno run -A jsr:@oxian/oxian-js dev --no-hot-reload
```

Development mode automatically:
- Enables hot reload
- Sets log level to debug
- Enables pretty printing
- Watches for file changes

### `routes` - List Routes

Display discovered routes:

```bash
# List all routes
deno run -A jsr:@oxian/oxian-js routes

# Show route details
deno run -A jsr:@oxian/oxian-js routes --verbose

# Filter by method
deno run -A jsr:@oxian/oxian-js routes --method=GET

# Export as JSON
deno run -A jsr:@oxian/oxian-js routes --format=json

# Export as table
deno run -A jsr:@oxian/oxian-js routes --format=table
```

Example output:

```
Routes:
  GET    /                     routes/index.ts
  GET    /health               routes/health.ts
  GET    /users                routes/users.ts
  POST   /users                routes/users.ts
  GET    /users/:id            routes/users/[id].ts
  PUT    /users/:id            routes/users/[id].ts
  DELETE /users/:id            routes/users/[id].ts
  GET    /docs/*               routes/docs/[...slug].ts
```

### `materialize` - Download/Extract Remote Source

Download and extract a remote source (e.g., GitHub) to a local directory. Outputs a JSON with the local `file://` root.

```bash
deno run -A jsr:@oxian/oxian-js materialize \
  --source=github:owner/repo?ref=main \
  --materialize-dir=.

# Example output
{"ok":true,"rootDir":"file:///abs/path/.oxian/materialized/github/owner/repo/<sha>/","ref":"main","sha":"<sha>","subdir":null}
```

Flags:
- `--source`: remote specifier (github:, https:) or file://
- `--materialize-dir`: destination directory (default: current directory)
- `--materialize-refresh`: force re-download and re-extract

### `prepare` - Run preRun Hooks in a Materialized Root

Execute `preRun` commands declared in the materialized project’s `oxian.config.*` (e.g., install deps, build assets).

```bash
deno run -A jsr:@oxian/oxian-js prepare --source=file:///abs/path/.oxian/materialized/github/owner/repo/<sha>/
```

Notes:
- `prepare` expects `--source` to point at a local `file://` root previously produced by `materialize`.
- Commands run using `/bin/sh -lc` (POSIX) or `cmd /c` (Windows).

## Configuration Options

### Global Flags

```bash
# Configuration file
--config=path/to/config.json

# Source location
--source=local|github:owner/repo|https://example.com

# Server port
--port=8080

# Server hostname
--hostname=0.0.0.0

# Enable/disable hypervisor
--hypervisor | --hypervisor=false

# Deno configuration
--deno-config=path/to/deno.json

# Log level
--log-level=debug|info|warn|error

# Environment
--env=development|production|test
```

### Source Formats

```bash
# Local directory
--source=./my-api
--source=/absolute/path/to/api

# GitHub repository
--source=github:owner/repo
--source=github:owner/repo/path
--source=github:owner/repo?ref=main
--source=github:owner/repo/api?ref=v1.0

# HTTP URL
--source=https://api.example.com/source
--source=http://localhost:3000/api-source

# Git repository
--source=git://github.com/owner/repo
--source=git+https://github.com/owner/repo
```

## Development Commands

### Development Workflow

```bash
# Start development server
deno run -A jsr:@oxian/oxian-js dev

# In another terminal - check routes
deno run -A jsr:@oxian/oxian-js routes

# Test specific endpoint
curl http://localhost:8080/api/test

# Check logs with debug level
OXIAN_LOG_LEVEL=debug deno run -A jsr:@oxian/oxian-js dev
```

### Hot Reload Configuration

```bash
# Default hot reload
deno run -A jsr:@oxian/oxian-js dev

# Custom watch patterns
deno run -A jsr:@oxian/oxian-js dev --watch="routes/**/*.ts,config/*.json"

# Disable hot reload
deno run -A jsr:@oxian/oxian-js dev --no-hot-reload

# Custom reload delay
deno run -A jsr:@oxian/oxian-js dev --reload-delay=500
```

### Debug Mode

```bash
# Enable debug logging
deno run -A jsr:@oxian/oxian-js dev --debug

# Debug specific components
OXIAN_DEBUG=router,loader deno run -A jsr:@oxian/oxian-js dev

# Inspect mode (for debugging with Chrome DevTools)
deno run -A --inspect jsr:@oxian/oxian-js dev
```

## Production Commands

### Production Server

```bash
# Production mode
NODE_ENV=production deno run -A jsr:@oxian/oxian-js start

# With specific configuration
deno run -A jsr:@oxian/oxian-js start --config=production.config.json

# Enable hypervisor for scaling
deno run -A jsr:@oxian/oxian-js start --hypervisor

# Custom worker count
deno run -A jsr:@oxian/oxian-js start --workers=8
```

### Health Checks

```bash
# Check server health
curl http://localhost:8080/health

# Check with timeout
curl --max-time 5 http://localhost:8080/health

# Health check script
#!/bin/bash
if curl -f -s http://localhost:8080/health > /dev/null; then
  echo "Server is healthy"
  exit 0
else
  echo "Server is unhealthy"
  exit 1
fi
```

## Environment Variables

### Configuration via Environment

```bash
# Server configuration
export OXIAN_PORT=3000
export OXIAN_HOST=0.0.0.0
export OXIAN_CONFIG=production.config.json

# Runtime configuration
export OXIAN_HOT_RELOAD=false
export OXIAN_LOG_LEVEL=warn
export OXIAN_WORKERS=auto

# Source configuration
export OXIAN_SOURCE=github:myorg/api
export GITHUB_TOKEN=ghp_your_token

# Security configuration
export OXIAN_CORS_ORIGINS="https://app.com,https://admin.app.com"
export JWT_SECRET=your-secret-key

# Start server with environment
deno run -A jsr:@oxian/oxian-js
```

### Environment File Loading

```bash
# Load from .env file
export $(cat .env | xargs) && deno run -A jsr:@oxian/oxian-js

# Load environment-specific file
export $(cat .env.production | xargs) && deno run -A jsr:@oxian/oxian-js start
```

## Scripting & Automation

### Bash Scripts

```bash
#!/bin/bash
# scripts/start-dev.sh

set -e

echo "Starting Oxian development server..."

# Load environment
if [ -f .env.development ]; then
  export $(cat .env.development | grep -v '^#' | xargs)
fi

# Start development server
deno run -A jsr:@oxian/oxian-js dev \
  --port=${PORT:-3000} \
  --config=${CONFIG:-oxian.config.json}
```

```bash
#!/bin/bash
# scripts/deploy.sh

set -e

ENVIRONMENT=${1:-staging}
echo "Deploying to $ENVIRONMENT..."

# Load environment configuration
export $(cat .env.$ENVIRONMENT | grep -v '^#' | xargs)

# Run health check
echo "Running health check..."
deno run -A jsr:@oxian/oxian-js routes

# Start server
echo "Starting server..."
deno run -A jsr:@oxian/oxian-js start \
  --config=configs/$ENVIRONMENT.config.json \
  --source=$OXIAN_SOURCE
```

### PowerShell Scripts

```powershell
# scripts/start-dev.ps1

param(
    [int]$Port = 3000,
    [string]$Config = "oxian.config.json"
)

Write-Host "Starting Oxian development server..."

# Load environment variables
if (Test-Path ".env.development") {
    Get-Content ".env.development" | ForEach-Object {
        if ($_ -match "^([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
        }
    }
}

# Start server
& deno run -A jsr:@oxian/oxian-js dev --port=$Port --config=$Config
```

### Node.js Scripts

```javascript
// scripts/cli-wrapper.js
const { spawn } = require('child_process');

class OxianCLI {
  constructor() {
    this.baseCmd = ['deno', 'run', '-A', 'jsr:@oxian/oxian-js'];
  }

  async start(options = {}) {
    const args = [...this.baseCmd, 'start'];
    
    if (options.port) args.push(`--port=${options.port}`);
    if (options.config) args.push(`--config=${options.config}`);
    if (options.source) args.push(`--source=${options.source}`);
    
    return this.run(args);
  }

  async dev(options = {}) {
    const args = [...this.baseCmd, 'dev'];
    
    if (options.port) args.push(`--port=${options.port}`);
    if (options.debug) args.push('--debug');
    
    return this.run(args);
  }

  async routes(options = {}) {
    const args = [...this.baseCmd, 'routes'];
    
    if (options.format) args.push(`--format=${options.format}`);
    if (options.verbose) args.push('--verbose');
    
    return this.run(args);
  }

  run(args) {
    return new Promise((resolve, reject) => {
      const process = spawn(args[0], args.slice(1), {
        stdio: 'inherit',
        shell: true
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });
  }
}

module.exports = OxianCLI;

// Usage
const oxian = new OxianCLI();

// Start development server
oxian.dev({ port: 3000, debug: true });
```

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/test.yml
name: Test API

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    
    steps:
    - uses: actions/checkout@v3
    
    - name: Setup Deno
      uses: denoland/setup-deno@v1
      with:
        deno-version: v1.40.x
    
    - name: Check routes
      run: deno run -A jsr:@oxian/oxian-js routes
    
    - name: Start server in background
      run: deno run -A jsr:@oxian/oxian-js start --port=8080 &
      
    - name: Wait for server
      run: |
        timeout 30 bash -c 'until curl -f http://localhost:8080/health; do sleep 1; done'
    
    - name: Run API tests
      run: |
        curl -f http://localhost:8080/
        curl -f http://localhost:8080/health
```

### Docker

```dockerfile
FROM denoland/deno:alpine

WORKDIR /app
COPY . .

# Check routes at build time
RUN deno run -A jsr:@oxian/oxian-js routes

# Start server
CMD ["deno", "run", "-A", "jsr:@oxian/oxian-js", "start"]
```

### Docker Compose

```yaml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
    command: deno run -A jsr:@oxian/oxian-js start --port=8080
    healthcheck:
      test: ["CMD", "deno", "run", "-A", "jsr:@oxian/oxian-js", "health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Troubleshooting

### Common Issues

**Permission errors:**
```bash
# Ensure all permissions are granted
deno run -A jsr:@oxian/oxian-js

# Or specific permissions
deno run --allow-net --allow-read --allow-env jsr:@oxian/oxian-js
```

**Port already in use:**
```bash
# Use different port
deno run -A jsr:@oxian/oxian-js --port=3001

# Find what's using the port
lsof -i :8080
netstat -tulpn | grep :8080
```

**Module not found:**
```bash
# Clear Deno cache
deno cache --reload jsr:@oxian/oxian-js

# Check Deno installation
deno --version
```

**GitHub token issues:**
```bash
# Check token
echo $GITHUB_TOKEN

# Test GitHub access
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user

# Use token file
export GITHUB_TOKEN=$(cat ~/.github-token)
```

### Debug Mode

```bash
# Enable all debugging
OXIAN_DEBUG=* deno run -A jsr:@oxian/oxian-js dev

# Debug specific components
OXIAN_DEBUG=router,loader deno run -A jsr:@oxian/oxian-js dev

# Debug with stack traces
deno run -A --unstable jsr:@oxian/oxian-js dev --debug
```

### Verbose Logging

```bash
# Verbose route information
deno run -A jsr:@oxian/oxian-js routes --verbose

# Debug level logging
OXIAN_LOG_LEVEL=debug deno run -A jsr:@oxian/oxian-js dev

# Pretty print logs in development
OXIAN_LOG_FORMAT=pretty deno run -A jsr:@oxian/oxian-js dev
```

## Advanced Usage

### Custom Deno Configuration

```bash
# Use custom Deno config
deno run -A --config=custom-deno.json jsr:@oxian/oxian-js

# With import map
deno run -A --import-map=import_map.json jsr:@oxian/oxian-js

# Combined
deno run -A --config=deno.json --import-map=imports.json jsr:@oxian/oxian-js
```

### Performance Profiling

```bash
# CPU profiling
deno run -A --cpu-prof jsr:@oxian/oxian-js start

# Memory usage
deno run -A --v8-flags=--expose-gc jsr:@oxian/oxian-js start

# Inspect with Chrome DevTools
deno run -A --inspect=127.0.0.1:9229 jsr:@oxian/oxian-js dev
```

### Task Automation

Create a `Makefile`:

```makefile
.PHONY: dev start test routes deploy

dev:
	@echo "Starting development server..."
	@deno run -A jsr:@oxian/oxian-js dev --port=3000

start:
	@echo "Starting production server..."
	@NODE_ENV=production deno run -A jsr:@oxian/oxian-js start

test:
	@echo "Testing routes..."
	@deno run -A jsr:@oxian/oxian-js routes

routes:
	@deno run -A jsr:@oxian/oxian-js routes --format=table

deploy:
	@echo "Deploying to production..."
	@./scripts/deploy.sh production
```

Or use Deno tasks in `deno.json`:

```json
{
  "tasks": {
    "dev": "deno run -A jsr:@oxian/oxian-js dev",
    "start": "deno run -A jsr:@oxian/oxian-js start",
    "routes": "deno run -A jsr:@oxian/oxian-js routes",
    "test": "deno test -A",
    "deploy": "./scripts/deploy.sh"
  }
}
```

Then run:

```bash
deno task dev
deno task start
deno task routes
```

## Best Practices

### ✅ Do

- Use environment variables for configuration
- Create scripts for common workflows
- Set up proper CI/CD pipelines
- Use health checks in production
- Enable appropriate logging levels
- Version your configuration files
- Document your CLI usage

### ❌ Don't

- Don't hardcode secrets in scripts
- Don't ignore error codes in automation
- Don't run development mode in production
- Don't forget to test CLI scripts
- Don't skip permission flags
- Don't ignore security best practices

---

The Oxian CLI is designed to be simple yet powerful. Start with basic commands and gradually build more sophisticated automation as your project grows.

**Next Steps:**
- [Configuration Guide](./configuration.md) - Advanced configuration
- [Deployment Guide](./deployment.md) - Production deployment
- [Best Practices](./best-practices.md) - CLI automation patterns
