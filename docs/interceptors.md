# 🎯 Interceptors - Before & After Request Hooks

Interceptors in Oxian provide powerful hooks that run before and after your middleware and handlers. They're perfect for cross-cutting concerns like logging, metrics, tracing, audit trails, and error transformation. Unlike middleware, interceptors wrap the entire request lifecycle.

## Overview

Interceptors in Oxian:

- **📁 File-based** - Defined in `interceptors.ts` files
- **🌳 Hierarchical** - Compose down the folder tree
- **🔄 Bidirectional** - Execute root→leaf before, leaf→root after
- **⚡ Async-friendly** - Support Promise-based operations
- **🎭 Transparent** - Don't modify request/response directly

```
Request Flow:
┌─────────────────────────────────────────────┐
│ 1. Root Interceptor beforeRun              │
│ 2. Leaf Interceptor beforeRun              │
│ 3. Middleware chain                        │
│ 4. Route handler                           │
│ 5. Leaf Interceptor afterRun               │
│ 6. Root Interceptor afterRun               │
└─────────────────────────────────────────────┘
```

## Basic Interceptors

### Creating Interceptors

Create an `interceptors.ts` file in any folder:

```ts
// routes/interceptors.ts
import type { Data, Context } from "jsr:@oxian/oxian-js/types";

export async function beforeRun(data: Data, context: Context) {
  // Runs before middleware and handlers
  console.log(`Request started: ${context.request.method} ${context.request.url}`);
  
  // Add timing
  context.oxian.startedAt = performance.now();
  
  // Can modify data/context like middleware
  return {
    data: {
      ...data,
      interceptorTimestamp: Date.now()
    }
  };
}

export async function afterRun(resultOrError: unknown, context: Context) {
  // Runs after handlers (success or error)
  const duration = performance.now() - context.oxian.startedAt;
  const isError = resultOrError instanceof Error;
  
  console.log(`Request completed: ${context.requestId} in ${duration}ms (${isError ? 'error' : 'success'})`);
  
  // Don't return anything - interceptors observe, don't modify results
}
```

### Interceptor Signatures

```ts
// Before interceptor - runs before middleware/handlers
export async function beforeRun(
  data: Data,
  context: Context
): Promise<{ data?: Data; context?: Partial<Context> } | void> | { data?: Data; context?: Partial<Context> } | void {
  // Setup logic here
}

// After interceptor - runs after handlers
export async function afterRun(
  resultOrError: unknown,  // Handler result or thrown error
  context: Context
): Promise<unknown | void> | unknown | void {
  // Cleanup/logging logic here
}
```

## Request Logging

### Structured Request Logging

```ts
// routes/interceptors.ts
export async function beforeRun(data, { requestId, request, oxian }) {
  const logEntry = {
    type: "request_start",
    requestId,
    method: request.method,
    url: request.url,
    userAgent: request.headers.get("user-agent"),
    timestamp: new Date().toISOString(),
    route: oxian.route
  };
  
  console.log(JSON.stringify(logEntry));
  
  // Store start time for duration calculation
  oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError, { requestId, oxian, request }) {
  const duration = Math.round(performance.now() - oxian.startedAt);
  const isError = resultOrError instanceof Error || 
    (typeof resultOrError === 'object' && resultOrError?.statusCode >= 400);
  
  const logEntry = {
    type: "request_end",
    requestId,
    method: request.method,
    url: request.url,
    route: oxian.route,
    duration,
    status: isError ? "error" : "success",
    timestamp: new Date().toISOString()
  };
  
  if (isError) {
    logEntry.error = resultOrError instanceof Error 
      ? resultOrError.message 
      : resultOrError?.message || "Unknown error";
  }
  
  console.log(JSON.stringify(logEntry));
}
```

### Request/Response Logging with Body

```ts
// routes/api/interceptors.ts
export async function beforeRun(data, context) {
  const { requestId, request } = context;
  
  // Log request details
  console.log(JSON.stringify({
    type: "api_request",
    requestId,
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body: request.method !== "GET" ? data : undefined,
    timestamp: new Date().toISOString()
  }));
  
  context.oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError, { requestId, oxian }) {
  const duration = performance.now() - oxian.startedAt;
  const isError = resultOrError instanceof Error;
  
  // Log response details
  console.log(JSON.stringify({
    type: "api_response",
    requestId,
    duration: Math.round(duration),
    success: !isError,
    response: isError ? undefined : resultOrError,
    error: isError ? resultOrError.message : undefined,
    timestamp: new Date().toISOString()
  }));
}
```

## Metrics & Monitoring

### Performance Metrics

```ts
// routes/interceptors.ts
const metrics = {
  requests: new Map(),
  counters: {
    total: 0,
    errors: 0,
    by_method: new Map(),
    by_route: new Map()
  }
};

export async function beforeRun(data, { requestId, request, oxian }) {
  // Start tracking request
  metrics.requests.set(requestId, {
    method: request.method,
    route: oxian.route,
    startTime: performance.now(),
    timestamp: Date.now()
  });
  
  // Update counters
  metrics.counters.total++;
  metrics.counters.by_method.set(
    request.method,
    (metrics.counters.by_method.get(request.method) || 0) + 1
  );
  metrics.counters.by_route.set(
    oxian.route,
    (metrics.counters.by_route.get(oxian.route) || 0) + 1
  );
}

export async function afterRun(resultOrError, { requestId }) {
  const requestMetric = metrics.requests.get(requestId);
  if (!requestMetric) return;
  
  const duration = performance.now() - requestMetric.startTime;
  const isError = resultOrError instanceof Error;
  
  if (isError) {
    metrics.counters.errors++;
  }
  
  // Log metrics
  console.log(JSON.stringify({
    type: "metrics",
    method: requestMetric.method,
    route: requestMetric.route,
    duration: Math.round(duration),
    success: !isError,
    timestamp: new Date().toISOString()
  }));
  
  // Clean up
  metrics.requests.delete(requestId);
}

// Expose metrics endpoint
export function getMetrics() {
  return {
    ...metrics.counters,
    active_requests: metrics.requests.size,
    by_method: Object.fromEntries(metrics.counters.by_method),
    by_route: Object.fromEntries(metrics.counters.by_route)
  };
}
```

### External Monitoring Integration

```ts
// routes/interceptors.ts
export async function beforeRun(data, context) {
  const { requestId, request } = context;
  
  // Send to external monitoring (e.g., DataDog, New Relic)
  if (Deno.env.get("MONITORING_ENABLED") === "true") {
    await sendMetric("request.started", 1, {
      method: request.method,
      route: context.oxian.route,
      requestId
    });
  }
  
  context.oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError, context) {
  const duration = performance.now() - context.oxian.startedAt;
  const isError = resultOrError instanceof Error;
  
  if (Deno.env.get("MONITORING_ENABLED") === "true") {
    // Response time metric
    await sendMetric("request.duration", duration, {
      method: context.request.method,
      route: context.oxian.route,
      status: isError ? "error" : "success"
    });
    
    // Error count
    if (isError) {
      await sendMetric("request.errors", 1, {
        method: context.request.method,
        route: context.oxian.route,
        error: resultOrError.message
      });
    }
  }
}

async function sendMetric(name: string, value: number, tags: Record<string, string>) {
  // Implementation depends on your monitoring service
  try {
    await fetch("https://api.monitoring-service.com/metrics", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${Deno.env.get("MONITORING_API_KEY")}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name, value, tags, timestamp: Date.now() })
    });
  } catch (error) {
    console.error("Failed to send metric:", error);
  }
}
```

## Security & Audit

### Audit Trail

```ts
// routes/api/interceptors.ts
export async function beforeRun(data, { requestId, request, user }) {
  // Log all API access for audit
  const auditEntry = {
    type: "api_access",
    requestId,
    userId: user?.id || "anonymous",
    method: request.method,
    url: request.url,
    userAgent: request.headers.get("user-agent"),
    clientIp: request.headers.get("x-forwarded-for") || 
              request.headers.get("x-real-ip") || 
              "unknown",
    timestamp: new Date().toISOString()
  };
  
  // Send to audit log storage
  await sendToAuditLog(auditEntry);
}

export async function afterRun(resultOrError, { requestId, user, request }) {
  const isError = resultOrError instanceof Error;
  const statusCode = isError 
    ? (resultOrError.statusCode || 500)
    : (resultOrError?.statusCode || 200);
  
  const auditEntry = {
    type: "api_response",
    requestId,
    userId: user?.id || "anonymous",
    method: request.method,
    url: request.url,
    statusCode,
    success: !isError,
    timestamp: new Date().toISOString()
  };
  
  // Log errors and sensitive operations
  if (isError || request.method !== "GET") {
    await sendToAuditLog(auditEntry);
  }
}

async function sendToAuditLog(entry: any) {
  try {
    // Could be database, external service, or file
    await Deno.writeTextFile(
      "./logs/audit.log",
      JSON.stringify(entry) + "\n",
      { append: true }
    );
  } catch (error) {
    console.error("Failed to write audit log:", error);
  }
}
```

### Security Monitoring

```ts
// routes/interceptors.ts
const securityEvents = new Map();

export async function beforeRun(data, { requestId, request }) {
  const clientIp = request.headers.get("x-forwarded-for") || "unknown";
  const userAgent = request.headers.get("user-agent") || "";
  
  // Detect suspicious patterns
  const suspiciousPatterns = [
    /\b(union|select|insert|delete|drop|script|javascript)\b/i,
    /<script|javascript:|vbscript:/i,
    /\.\./,  // Path traversal
    /__proto__|constructor/  // Prototype pollution
  ];
  
  const url = request.url;
  const isSuspicious = suspiciousPatterns.some(pattern => 
    pattern.test(url) || pattern.test(userAgent)
  );
  
  if (isSuspicious) {
    const event = {
      type: "suspicious_request",
      requestId,
      clientIp,
      userAgent,
      url,
      timestamp: Date.now()
    };
    
    console.warn("Suspicious request detected:", event);
    await reportSecurityEvent(event);
  }
  
  // Rate limiting tracking
  const key = `rate_limit:${clientIp}`;
  const requests = securityEvents.get(key) || [];
  const now = Date.now();
  const windowMs = 60000; // 1 minute
  
  // Clean old requests
  const recentRequests = requests.filter(time => now - time < windowMs);
  recentRequests.push(now);
  securityEvents.set(key, recentRequests);
  
  // Check for rate limit violations
  if (recentRequests.length > 100) {
    await reportSecurityEvent({
      type: "rate_limit_violation",
      clientIp,
      requestCount: recentRequests.length,
      timestamp: now
    });
  }
}

async function reportSecurityEvent(event: any) {
  // Send to security monitoring system
  console.error("Security event:", event);
  
  // Could integrate with security services
  // await sendToSecurityService(event);
}
```

## Error Handling & Transformation

### Global Error Transformation

```ts
// routes/interceptors.ts
export async function afterRun(resultOrError, { requestId, request }) {
  // Transform errors for consistent API responses
  if (resultOrError instanceof Error) {
    const errorResponse = {
      error: {
        message: resultOrError.message,
        code: "INTERNAL_ERROR",
        requestId,
        timestamp: new Date().toISOString()
      }
    };
    
    // Add stack trace in development
    if (Deno.env.get("NODE_ENV") === "development") {
      errorResponse.error.stack = resultOrError.stack;
    }
    
    // Log error details
    console.error("Request error:", {
      requestId,
      method: request.method,
      url: request.url,
      error: resultOrError.message,
      stack: resultOrError.stack
    });
    
    // Return transformed error (this replaces the original error)
    return errorResponse;
  }
  
  // Don't modify successful responses
  return resultOrError;
}
```

### Error Classification

```ts
// routes/interceptors.ts
export async function afterRun(resultOrError, { requestId, request, oxian }) {
  if (resultOrError instanceof Error) {
    const errorInfo = classifyError(resultOrError);
    
    const logEntry = {
      type: "error",
      requestId,
      method: request.method,
      url: request.url,
      route: oxian.route,
      error: {
        message: resultOrError.message,
        type: errorInfo.type,
        severity: errorInfo.severity,
        code: errorInfo.code
      },
      timestamp: new Date().toISOString()
    };
    
    // Log based on severity
    if (errorInfo.severity === "critical") {
      console.error("CRITICAL ERROR:", logEntry);
      await sendAlert(logEntry);
    } else if (errorInfo.severity === "warning") {
      console.warn("Warning:", logEntry);
    } else {
      console.log("Info:", logEntry);
    }
  }
}

function classifyError(error: Error) {
  // Network/external service errors
  if (error.message.includes("fetch failed") || error.message.includes("ECONNREFUSED")) {
    return { type: "network", severity: "warning", code: "NETWORK_ERROR" };
  }
  
  // Database errors
  if (error.message.includes("database") || error.message.includes("SQL")) {
    return { type: "database", severity: "critical", code: "DB_ERROR" };
  }
  
  // Validation errors
  if (error.name === "ValidationError" || error.message.includes("validation")) {
    return { type: "validation", severity: "info", code: "VALIDATION_ERROR" };
  }
  
  // Authentication errors
  if (error.message.includes("unauthorized") || error.message.includes("forbidden")) {
    return { type: "auth", severity: "warning", code: "AUTH_ERROR" };
  }
  
  // Default to internal error
  return { type: "internal", severity: "critical", code: "INTERNAL_ERROR" };
}

async function sendAlert(errorInfo: any) {
  // Send to alerting system (Slack, PagerDuty, etc.)
  try {
    await fetch(Deno.env.get("SLACK_WEBHOOK_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `🚨 Critical Error in ${errorInfo.route}`,
        attachments: [{
          color: "danger",
          fields: [
            { title: "Error", value: errorInfo.error.message, short: false },
            { title: "Request ID", value: errorInfo.requestId, short: true },
            { title: "Route", value: errorInfo.route, short: true }
          ]
        }]
      })
    });
  } catch (alertError) {
    console.error("Failed to send alert:", alertError);
  }
}
```

## Advanced Patterns

### Distributed Tracing

```ts
// routes/interceptors.ts
export async function beforeRun(data, context) {
  const { requestId, request } = context;
  
  // Start distributed trace
  const traceId = request.headers.get("x-trace-id") || generateTraceId();
  const spanId = generateSpanId();
  
  // Add tracing headers for downstream services
  context.tracing = {
    traceId,
    spanId,
    parentSpanId: request.headers.get("x-parent-span-id")
  };
  
  // Send trace start
  await sendTraceEvent({
    traceId,
    spanId,
    operation: `${request.method} ${context.oxian.route}`,
    startTime: Date.now(),
    tags: {
      method: request.method,
      route: context.oxian.route,
      requestId
    }
  });
  
  context.oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError, context) {
  const duration = performance.now() - context.oxian.startedAt;
  const isError = resultOrError instanceof Error;
  
  // Send trace end
  await sendTraceEvent({
    traceId: context.tracing.traceId,
    spanId: context.tracing.spanId,
    operation: `${context.request.method} ${context.oxian.route}`,
    duration: Math.round(duration * 1000), // microseconds
    success: !isError,
    error: isError ? resultOrError.message : undefined
  });
}

function generateTraceId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function generateSpanId() {
  return Math.random().toString(16).substr(2, 16);
}

async function sendTraceEvent(event: any) {
  // Send to tracing system (Jaeger, Zipkin, etc.)
  console.log("Trace event:", event);
}
```

### Request Correlation

```ts
// routes/interceptors.ts
const activeRequests = new Map();

export async function beforeRun(data, { requestId, request }) {
  // Track active request
  activeRequests.set(requestId, {
    method: request.method,
    url: request.url,
    startTime: Date.now(),
    userId: data.userId // if available
  });
  
  // Add correlation ID to all downstream requests
  if (!request.headers.has("x-correlation-id")) {
    request.headers.set("x-correlation-id", requestId);
  }
}

export async function afterRun(resultOrError, { requestId }) {
  // Clean up tracking
  activeRequests.delete(requestId);
}

// Health check can show active requests
export function getActiveRequests() {
  return Array.from(activeRequests.entries()).map(([id, info]) => ({
    requestId: id,
    ...info,
    duration: Date.now() - info.startTime
  }));
}
```

## Testing Interceptors

### Unit Testing

```ts
// tests/interceptors.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { beforeRun, afterRun } from "../routes/interceptors.ts";

Deno.test("beforeRun adds timing", async () => {
  const context = {
    requestId: "test-123",
    request: { method: "GET", url: "http://localhost/test" },
    oxian: {}
  };
  
  await beforeRun({}, context);
  
  assertEquals(typeof context.oxian.startedAt, "number");
});

Deno.test("afterRun logs completion", async () => {
  const context = {
    requestId: "test-123",
    request: { method: "GET", url: "http://localhost/test" },
    oxian: { startedAt: performance.now() }
  };
  
  // Test successful result
  await afterRun({ success: true }, context);
  
  // Test error result
  await afterRun(new Error("Test error"), context);
});
```

### Integration Testing

```ts
// tests/integration/interceptors.test.ts
Deno.test("interceptors run in correct order", async () => {
  const logs = [];
  
  // Mock console.log to capture logs
  const originalLog = console.log;
  console.log = (message) => logs.push(message);
  
  try {
    // Make request to trigger interceptors
    await fetch("http://localhost:8080/test");
    
    // Verify log order
    assert(logs.some(log => log.includes("request_start")));
    assert(logs.some(log => log.includes("request_end")));
  } finally {
    console.log = originalLog;
  }
});
```

## Best Practices

### ✅ Do

- Use interceptors for cross-cutting concerns (logging, metrics, tracing)
- Keep interceptors lightweight and fast
- Handle errors gracefully in interceptors
- Use structured logging for better observability
- Clean up resources in afterRun
- Use async/await for external service calls
- Implement proper error classification

### ❌ Don't

- Don't put business logic in interceptors
- Don't modify request/response data unless necessary
- Don't ignore interceptor errors
- Don't make interceptors too complex
- Don't block the request unnecessarily
- Don't forget to clean up resources
- Don't log sensitive information

## Example: Complete Observability Stack

```ts
// routes/interceptors.ts
import { createLogger } from "../utils/logger.ts";
import { createMetrics } from "../utils/metrics.ts";
import { createTracer } from "../utils/tracer.ts";

const logger = createLogger();
const metrics = createMetrics();
const tracer = createTracer();

export async function beforeRun(data, context) {
  const { requestId, request, oxian } = context;
  
  // Start timing
  oxian.startedAt = performance.now();
  
  // Start trace
  const span = tracer.startSpan(`${request.method} ${oxian.route}`, {
    requestId,
    method: request.method,
    route: oxian.route
  });
  context.span = span;
  
  // Log request
  logger.info("Request started", {
    requestId,
    method: request.method,
    url: request.url,
    route: oxian.route,
    userAgent: request.headers.get("user-agent")
  });
  
  // Update metrics
  metrics.increment("requests.total", {
    method: request.method,
    route: oxian.route
  });
}

export async function afterRun(resultOrError, context) {
  const { requestId, request, oxian, span } = context;
  const duration = performance.now() - oxian.startedAt;
  const isError = resultOrError instanceof Error;
  
  // Complete trace
  span.finish({
    duration,
    success: !isError,
    error: isError ? resultOrError.message : undefined
  });
  
  // Log completion
  logger.info("Request completed", {
    requestId,
    method: request.method,
    route: oxian.route,
    duration: Math.round(duration),
    success: !isError
  });
  
  // Update metrics
  metrics.histogram("requests.duration", duration, {
    method: request.method,
    route: oxian.route,
    status: isError ? "error" : "success"
  });
  
  if (isError) {
    metrics.increment("requests.errors", {
      method: request.method,
      route: oxian.route
    });
    
    logger.error("Request error", {
      requestId,
      error: resultOrError.message,
      stack: resultOrError.stack
    });
  }
}
```

---

Interceptors provide powerful observability and cross-cutting functionality without cluttering your business logic. Use them to build robust monitoring, logging, and debugging capabilities.

**Next Steps:**
- [Error Handling](./error-handling.md) - Global error strategies
- [Monitoring Guide](./monitoring.md) - Production observability
- [Security Guide](./security.md) - Security best practices
