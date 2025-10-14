# 🚀 Deployment - Production Deployment Guide

This comprehensive guide covers deploying Oxian applications to production
environments, from simple single-instance deployments to sophisticated
multi-region setups with auto-scaling and monitoring.

## Deployment Overview

Oxian supports multiple deployment strategies:

- **🐳 Container deployments** - Docker, Kubernetes, cloud containers
- **🖥️ Traditional servers** - VPS, dedicated servers, on-premises

## Container Deployment

### Docker

Create a `Dockerfile`:

```dockerfile
FROM denoland/deno:alpine-2.4.0

# Set working directory
WORKDIR /app

# Copy application files
COPY . .

# Cache dependencies
RUN deno cache cli.ts

# Create non-root user
RUN addgroup -g 1001 -S deno && \
    adduser -S deno -u 1001
USER deno

# Expose port
EXPOSE 8080

# Start application
CMD ["deno", "run", "-A", "cli.ts"]
```

Build and run:

```bash
# Build image
docker build -t my-oxian-api .

# Run container
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://... \
  -e JWT_SECRET=your-secret \
  my-oxian-api
```

### Docker Compose

For local development and testing:

```yaml
# docker-compose.yml
version: "3.8"

services:
  api:
    build: .
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:password@db:5432/myapp
      - REDIS_URL=redis://redis:6379
      - JWT_SECRET=your-secret-key
    depends_on:
      - db
      - redis
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=myapp
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped

volumes:
  postgres_data:
```

Run with:

```bash
docker-compose up -d
```

## Kubernetes Deployment

### Basic Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oxian-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: oxian-api
  template:
    metadata:
      labels:
        app: oxian-api
    spec:
      containers:
        - name: api
          image: myregistry/oxian-api:latest
          ports:
            - containerPort: 8080
          env:
            - name: NODE_ENV
              value: "production"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: api-secrets
                  key: database-url
            - name: JWT_SECRET
              valueFrom:
                secretKeyRef:
                  name: api-secrets
                  key: jwt-secret
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 30
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: oxian-api-service
spec:
  selector:
    app: oxian-api
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: oxian-api-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
    - host: api.myapp.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: oxian-api-service
                port:
                  number: 80
```

### Secrets

```yaml
# k8s/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-secrets
type: Opaque
data:
  database-url: <base64-encoded-database-url>
  jwt-secret: <base64-encoded-jwt-secret>
```

Deploy:

```bash
# Apply secrets
kubectl apply -f k8s/secrets.yaml

# Deploy application
kubectl apply -f k8s/deployment.yaml

# Check status
kubectl get pods
kubectl get services
kubectl get ingress
```

## Environment Configuration

### Production Configuration

```json
{
  "server": {
    "port": 8080,
    "hostname": "0.0.0.0"
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
  "security": {
    "cors": {
      "allowedOrigins": ["https://myapp.com"],
      "allowCredentials": true
    },
    "defaultHeaders": {
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-xss-protection": "1; mode=block"
    }
  },
  "logging": {
    "level": "warn",
    "format": "json"
  }
}
```

### Environment Variables

Create a comprehensive environment setup:

```bash
# .env.production
NODE_ENV=production

# Server
PORT=8080
HOST=0.0.0.0

# Database
DATABASE_URL=postgresql://user:pass@host:5432/db
DATABASE_POOL_MIN=5
DATABASE_POOL_MAX=20

# Cache
REDIS_URL=redis://redis:6379
REDIS_POOL_SIZE=10

# Authentication
JWT_SECRET=your-very-long-and-secure-secret
JWT_EXPIRES_IN=24h

# External Services
SENDGRID_API_KEY=SG.xxx
S3_BUCKET=my-app-uploads
S3_REGION=us-east-1
S3_ACCESS_KEY=AKIAXX
S3_SECRET_KEY=xxx

# Monitoring
MONITORING_ENABLED=true
DATADOG_API_KEY=xxx
SENTRY_DSN=https://xxx@sentry.io/xxx

# Feature Flags
FEATURE_NEW_API=true
FEATURE_BETA_DASHBOARD=false
```

## CI/CD Pipeline

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Deno
        uses: denoland/setup-deno@v1
        with:
          deno-version: v1.40.x

      - name: Run tests
        run: deno test -A

      - name: Check formatting
        run: deno fmt --check

      - name: Run linter
        run: deno lint

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v2
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v4
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}

      - name: Build and push Docker image
        uses: docker/build-push-action@v3
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy to Kubernetes
        run: |
          # Update Kubernetes deployment
          kubectl set image deployment/oxian-api \
            api=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:main
```

### GitLab CI

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build
  - deploy

variables:
  DOCKER_IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

test:
  stage: test
  image: denoland/deno:alpine
  script:
    - deno test -A
    - deno fmt --check
    - deno lint

build:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker build -t $DOCKER_IMAGE .
    - docker push $DOCKER_IMAGE
  only:
    - main

deploy:
  stage: deploy
  image: kubectl:latest
  script:
    - kubectl set image deployment/oxian-api api=$DOCKER_IMAGE
    - kubectl rollout status deployment/oxian-api
  only:
    - main
```

## Health Checks & Monitoring

### Health Check Endpoint

```typescript
// routes/health.ts
export async function GET(_, { dependencies }) {
  const { database, redis, externalAPI } = dependencies;

  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: Deno.env.get("APP_VERSION") || "unknown",
    checks: {},
  };

  // Database check
  try {
    await database.ping();
    health.checks.database = "healthy";
  } catch (error) {
    health.checks.database = "unhealthy";
    health.status = "degraded";
  }

  // Redis check
  try {
    await redis.ping();
    health.checks.redis = "healthy";
  } catch (error) {
    health.checks.redis = "unhealthy";
    health.status = "degraded";
  }

  // External API check
  try {
    await externalAPI.healthCheck();
    health.checks.external_api = "healthy";
  } catch (error) {
    health.checks.external_api = "unhealthy";
    health.status = "degraded";
  }

  const statusCode = health.status === "healthy" ? 200 : 503;
  return new Response(JSON.stringify(health), {
    status: statusCode,
    headers: { "content-type": "application/json" },
  });
}
```

### Prometheus Metrics

```typescript
// routes/metrics.ts
const metrics = {
  http_requests_total: new Map(),
  http_request_duration: new Map(),
  active_connections: 0,
};

export function GET() {
  const output = [];

  // HTTP requests total
  output.push("# TYPE http_requests_total counter");
  for (const [key, value] of metrics.http_requests_total) {
    output.push(`http_requests_total{${key}} ${value}`);
  }

  // Request duration
  output.push("# TYPE http_request_duration histogram");
  for (const [key, value] of metrics.http_request_duration) {
    output.push(`http_request_duration{${key}} ${value}`);
  }

  // Active connections
  output.push("# TYPE active_connections gauge");
  output.push(`active_connections ${metrics.active_connections}`);

  return new Response(output.join("\n"), {
    headers: { "content-type": "text/plain" },
  });
}
```

## Load Balancing & Scaling

### HAProxy Configuration

```
# haproxy.cfg
global
    daemon
    maxconn 4096

defaults
    mode http
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms

frontend api_frontend
    bind *:80
    bind *:443 ssl crt /etc/ssl/certs/api.pem
    redirect scheme https if !{ ssl_fc }
    default_backend api_servers

backend api_servers
    balance roundrobin
    option httpchk GET /health
    http-check expect status 200
    
    server api1 api1:8080 check
    server api2 api2:8080 check
    server api3 api3:8080 check
```

### NGINX Load Balancer

```nginx
upstream api_backend {
    least_conn;
    server api1:8080 max_fails=3 fail_timeout=30s;
    server api2:8080 max_fails=3 fail_timeout=30s;
    server api3:8080 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    listen 443 ssl http2;
    server_name api.myapp.com;
    
    ssl_certificate /etc/ssl/certs/api.crt;
    ssl_certificate_key /etc/ssl/private/api.key;
    
    location / {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Health check
        proxy_next_upstream error timeout invalid_header http_500 http_502 http_503;
    }
    
    location /health {
        access_log off;
        proxy_pass http://api_backend;
    }
}
```

## Database Migrations

### Migration System

```typescript
// scripts/migrate.ts
import { migrate } from "./migrations/index.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL");
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  Deno.exit(1);
}

try {
  await migrate(DATABASE_URL);
  console.log("Migrations completed successfully");
} catch (error) {
  console.error("Migration failed:", error);
  Deno.exit(1);
}
```

### Migration in CI/CD

```yaml
# Add to GitHub Actions
- name: Run database migrations
  run: deno run -A scripts/migrate.ts
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

## Security Hardening

### Production Security Checklist

- ✅ Use HTTPS only (TLS 1.2+)
- ✅ Set security headers (CSP, HSTS, etc.)
- ✅ Enable CORS with specific origins
- ✅ Use environment variables for secrets
- ✅ Implement rate limiting
- ✅ Enable request logging
- ✅ Use non-root containers
- ✅ Scan images for vulnerabilities
- ✅ Keep dependencies updated

### Security Headers

```typescript
// middleware/security.ts
export default function (data, { response }) {
  response.headers({
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-xss-protection": "1; mode=block",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
  });

  return {};
}
```

## Monitoring & Observability

### Application Monitoring

```typescript
// monitoring/setup.ts
import * as Sentry from "https://deno.land/x/sentry/index.js";

// Initialize Sentry
Sentry.init({
  dsn: Deno.env.get("SENTRY_DSN"),
  environment: Deno.env.get("NODE_ENV"),
  tracesSampleRate: 0.1,
});

// Add to interceptors
export async function afterRun(resultOrError, context) {
  if (resultOrError instanceof Error) {
    Sentry.captureException(resultOrError, {
      tags: {
        route: context.oxian.route,
        method: context.request.method,
      },
      user: {
        id: context.user?.id,
      },
    });
  }
}
```

### Structured Logging

```typescript
// logging/production.ts
export function createProductionLogger() {
  return {
    info: (message: string, meta: any = {}) => {
      console.log(JSON.stringify({
        level: "info",
        message,
        timestamp: new Date().toISOString(),
        service: "oxian-api",
        version: Deno.env.get("APP_VERSION"),
        ...meta,
      }));
    },

    error: (message: string, error: Error, meta: any = {}) => {
      console.error(JSON.stringify({
        level: "error",
        message,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        timestamp: new Date().toISOString(),
        service: "oxian-api",
        version: Deno.env.get("APP_VERSION"),
        ...meta,
      }));
    },
  };
}
```

## Backup & Disaster Recovery

### Database Backups

```bash
#!/bin/bash
# scripts/backup.sh

DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_${DATE}.sql"

# Create backup
pg_dump $DATABASE_URL > $BACKUP_FILE

# Upload to S3
aws s3 cp $BACKUP_FILE s3://my-backups/database/

# Clean up local file
rm $BACKUP_FILE

# Keep only last 30 days of backups
aws s3 ls s3://my-backups/database/ | while read -r line; do
  createDate=$(echo $line | awk '{print $1" "$2}')
  createDate=$(date -d "$createDate" +%s)
  olderThan=$(date -d "30 days ago" +%s)
  if [[ $createDate -lt $olderThan ]]; then
    fileName=$(echo $line | awk '{print $4}')
    if [[ $fileName != "" ]]; then
      aws s3 rm s3://my-backups/database/$fileName
    fi
  fi
done
```

### Blue-Green Deployment

```yaml
# blue-green-deploy.yml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: oxian-api
spec:
  replicas: 5
  strategy:
    blueGreen:
      activeService: oxian-api-active
      previewService: oxian-api-preview
      autoPromotionEnabled: false
      scaleDownDelaySeconds: 30
      prePromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: oxian-api-preview
      postPromotionAnalysis:
        templates:
          - templateName: success-rate
        args:
          - name: service-name
            value: oxian-api-active
  selector:
    matchLabels:
      app: oxian-api
  template:
    metadata:
      labels:
        app: oxian-api
    spec:
      containers:
        - name: oxian-api
          image: myregistry/oxian-api:latest
```

## Performance Optimization

### Production Optimizations

```json
{
  "runtime": {
    "hv": {
      "enabled": true,
      "workers": 8,
      "strategy": "least_busy",
      "autoscale": {
        "enabled": true,
        "min": 4,
        "max": 20,
        "targetInflightPerWorker": 50
      }
    }
  },
  "server": {
    "keepAlive": true,
    "compression": true
  }
}
```

### Caching Strategy

```typescript
// caching/redis.ts
export class RedisCache {
  constructor(private redis: RedisClient) {}

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  async set(key: string, value: any, ttl = 3600): Promise<void> {
    await this.redis.setex(key, ttl, JSON.stringify(value));
  }

  async invalidate(pattern: string): Promise<void> {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

## Best Practices

### ✅ Production Checklist

- ✅ Use environment variables for configuration
- ✅ Implement comprehensive health checks
- ✅ Set up monitoring and alerting
- ✅ Use container orchestration
- ✅ Implement blue-green deployments
- ✅ Set up automated backups
- ✅ Enable logging and observability
- ✅ Secure with proper headers and TLS
- ✅ Test disaster recovery procedures
- ✅ Monitor resource usage and costs

### ❌ Don't

- ❌ Don't hardcode secrets in code
- ❌ Don't deploy without health checks
- ❌ Don't ignore security headers
- ❌ Don't skip backup testing
- ❌ Don't deploy without monitoring
- ❌ Don't use default passwords
- ❌ Don't ignore dependency updates
- ❌ Don't skip load testing

---

Production deployment requires careful planning and robust infrastructure. Start
with simple deployments and gradually add complexity as your application scales.

**Next Steps:**

- [Monitoring Guide](./monitoring.md) - Set up observability
- [Security Guide](./security.md) - Harden your deployment
- [Performance Guide](./performance.md) - Optimize for scale
