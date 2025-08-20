# 🚨 Error Handling - Robust Error Management

Oxian provides comprehensive error handling capabilities that help you build resilient APIs. From simple throw statements to sophisticated error classification and global handling, this guide covers all aspects of error management in Oxian.

## Error Handling Overview

Oxian error handling features:

- **🎯 Simple throwing** - Throw objects with status codes
- **🔧 Structured errors** - Consistent error response formats
- **🌐 Global handling** - Centralized error processing via interceptors
- **📝 Error classification** - Categorize errors by type and severity
- **🔍 Error tracking** - Request correlation and error aggregation
- **🛡️ Security** - Prevent information leakage

## Basic Error Throwing

### Simple Error Objects

The simplest way to handle errors is throwing objects:

```ts
// routes/users/[id].ts
export function GET({ id }) {
  if (!id) {
    throw {
      message: "User ID is required",
      statusCode: 400,
      statusText: "Bad Request"
    };
  }
  
  const user = findUser(id);
  if (!user) {
    throw {
      message: "User not found",
      statusCode: 404,
      statusText: "Not Found"
    };
  }
  
  return user;
}
```

### Standard Error Properties

```ts
throw {
  message: string,           // Error message (required)
  statusCode?: number,       // HTTP status code (default: 500)
  statusText?: string,       // HTTP status text
  code?: string,             // Error code for programmatic handling
  details?: unknown          // Additional error details
};
```

### Regular JavaScript Errors

```ts
export function GET({ data }) {
  try {
    const parsed = JSON.parse(data);
    return { result: parsed };
  } catch (error) {
    // Regular errors become 500 responses
    throw new Error("Invalid JSON data");
  }
}
```

## OxianHttpError Class

For more structured error handling, use the `OxianHttpError` class:

```ts
import { OxianHttpError } from "jsr:@oxian/oxian-js/types";

export function POST({ name, email }) {
  if (!name) {
    throw new OxianHttpError("Name is required", {
      statusCode: 400,
      code: "MISSING_NAME",
      details: { field: "name", provided: name }
    });
  }
  
  if (!email || !email.includes("@")) {
    throw new OxianHttpError("Valid email is required", {
      statusCode: 400,
      code: "INVALID_EMAIL",
      details: { field: "email", provided: email }
    });
  }
  
  return createUser({ name, email });
}
```

### OxianHttpError Properties

```ts
class OxianHttpError extends Error {
  code?: string;              // Error code
  statusCode: number;         // HTTP status (default: 500)
  statusText?: string;        // HTTP status text
  details?: unknown;          // Additional details
}
```

## Common Error Patterns

### Validation Errors

```ts
// routes/users.ts
export function POST(data) {
  const errors = [];
  
  if (!data.name || typeof data.name !== "string") {
    errors.push({ field: "name", message: "Name is required" });
  }
  
  if (!data.email || !data.email.includes("@")) {
    errors.push({ field: "email", message: "Valid email is required" });
  }
  
  if (data.age !== undefined && (data.age < 0 || data.age > 150)) {
    errors.push({ field: "age", message: "Age must be between 0 and 150" });
  }
  
  if (errors.length > 0) {
    throw {
      message: "Validation failed",
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: { errors }
    };
  }
  
  return createUser(data);
}
```

### Not Found Errors

```ts
// routes/users/[id].ts
export async function GET({ id }, { dependencies }) {
  const { userService } = dependencies;
  
  try {
    const user = await userService.findById(id);
    return user;
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      throw {
        message: `User with ID ${id} not found`,
        statusCode: 404,
        code: "USER_NOT_FOUND",
        details: { userId: id }
      };
    }
    
    // Re-throw other errors
    throw error;
  }
}
```

### Authorization Errors

```ts
// routes/admin/users.ts
export function GET(_, { user }) {
  if (!user) {
    throw {
      message: "Authentication required",
      statusCode: 401,
      code: "AUTHENTICATION_REQUIRED"
    };
  }
  
  if (!user.roles?.includes("admin")) {
    throw {
      message: "Admin access required",
      statusCode: 403,
      code: "INSUFFICIENT_PERMISSIONS",
      details: { 
        required: ["admin"], 
        provided: user.roles || [] 
      }
    };
  }
  
  return getAdminData();
}
```

### Rate Limiting Errors

```ts
// middleware.ts
export default function(data, context) {
  const rateLimitResult = checkRateLimit(context.request);
  
  if (rateLimitResult.exceeded) {
    throw {
      message: "Rate limit exceeded",
      statusCode: 429,
      statusText: "Too Many Requests",
      code: "RATE_LIMIT_EXCEEDED",
      details: {
        limit: rateLimitResult.limit,
        remaining: 0,
        resetTime: rateLimitResult.resetTime
      },
      headers: {
        "retry-after": rateLimitResult.retryAfter.toString(),
        "x-ratelimit-limit": rateLimitResult.limit.toString(),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": rateLimitResult.resetTime.toString()
      }
    };
  }
  
  return {};
}
```

## Global Error Handling

### Error Interceptors

Use interceptors to handle errors globally:

```ts
// routes/interceptors.ts
export async function afterRun(resultOrError, context) {
  if (resultOrError instanceof Error || resultOrError?.statusCode >= 400) {
    return handleGlobalError(resultOrError, context);
  }
  
  return resultOrError;
}

function handleGlobalError(error, context) {
  const { requestId, request } = context;
  
  // Log error
  console.error("Request error:", {
    requestId,
    method: request.method,
    url: request.url,
    error: error.message || error,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  // Transform error for response
  if (error instanceof Error) {
    // Unexpected errors - don't leak internal details
    return {
      error: {
        message: "Internal server error",
        code: "INTERNAL_ERROR",
        requestId,
        timestamp: new Date().toISOString()
      }
    };
  }
  
  // Structured errors - return as-is with request context
  return {
    error: {
      message: error.message,
      code: error.code || "UNKNOWN_ERROR",
      statusCode: error.statusCode || 500,
      details: error.details,
      requestId,
      timestamp: new Date().toISOString()
    }
  };
}
```

### Error Classification

```ts
// routes/interceptors.ts
export async function afterRun(resultOrError, context) {
  if (isError(resultOrError)) {
    const classified = classifyError(resultOrError);
    
    // Log based on classification
    logError(classified, context);
    
    // Send alerts for critical errors
    if (classified.severity === "critical") {
      await sendAlert(classified, context);
    }
    
    // Transform error response
    return formatErrorResponse(classified, context);
  }
  
  return resultOrError;
}

function classifyError(error) {
  const classification = {
    type: "unknown",
    severity: "error",
    code: error.code || "UNKNOWN_ERROR",
    message: error.message || "Unknown error",
    originalError: error
  };
  
  // Client errors (4xx)
  if (error.statusCode >= 400 && error.statusCode < 500) {
    classification.type = "client_error";
    classification.severity = "warning";
    
    if (error.statusCode === 401) {
      classification.type = "authentication_error";
    } else if (error.statusCode === 403) {
      classification.type = "authorization_error";
    } else if (error.statusCode === 404) {
      classification.type = "not_found_error";
      classification.severity = "info";
    } else if (error.statusCode === 422) {
      classification.type = "validation_error";
    }
  }
  
  // Server errors (5xx)
  else if (error.statusCode >= 500) {
    classification.type = "server_error";
    classification.severity = "critical";
    
    if (error.message?.includes("database")) {
      classification.type = "database_error";
    } else if (error.message?.includes("network") || error.message?.includes("fetch")) {
      classification.type = "network_error";
    }
  }
  
  // JavaScript errors
  else if (error instanceof Error) {
    classification.type = "runtime_error";
    classification.severity = "critical";
    
    if (error.name === "TypeError") {
      classification.type = "type_error";
    } else if (error.name === "ReferenceError") {
      classification.type = "reference_error";
    }
  }
  
  return classification;
}
```

## Error Response Formats

### Standard Error Response

```ts
// Consistent error response format
{
  "error": {
    "message": "User not found",
    "code": "USER_NOT_FOUND",
    "requestId": "req_abc123",
    "timestamp": "2024-01-20T10:30:00.000Z",
    "details": {
      "userId": "invalid-id"
    }
  }
}
```

### Validation Error Response

```ts
{
  "error": {
    "message": "Validation failed",
    "code": "VALIDATION_ERROR",
    "requestId": "req_abc123",
    "timestamp": "2024-01-20T10:30:00.000Z",
    "details": {
      "errors": [
        {
          "field": "email",
          "message": "Valid email is required",
          "provided": "invalid-email"
        },
        {
          "field": "age",
          "message": "Age must be a number",
          "provided": "abc"
        }
      ]
    }
  }
}
```

### Rate Limit Error Response

```ts
{
  "error": {
    "message": "Rate limit exceeded",
    "code": "RATE_LIMIT_EXCEEDED",
    "requestId": "req_abc123",
    "timestamp": "2024-01-20T10:30:00.000Z",
    "details": {
      "limit": 100,
      "remaining": 0,
      "resetTime": 1642693860000
    }
  }
}
```

## Error Logging & Monitoring

### Structured Error Logging

```ts
function logError(classified, context) {
  const logEntry = {
    type: "error",
    severity: classified.severity,
    requestId: context.requestId,
    method: context.request.method,
    url: context.request.url,
    route: context.oxian.route,
    error: {
      type: classified.type,
      code: classified.code,
      message: classified.message,
      stack: classified.originalError?.stack
    },
    user: context.user?.id,
    timestamp: new Date().toISOString()
  };
  
  // Log based on severity
  switch (classified.severity) {
    case "critical":
      console.error(JSON.stringify(logEntry));
      break;
    case "error":
      console.error(JSON.stringify(logEntry));
      break;
    case "warning":
      console.warn(JSON.stringify(logEntry));
      break;
    case "info":
      console.info(JSON.stringify(logEntry));
      break;
  }
}
```

### Error Metrics

```ts
// routes/interceptors.ts
const errorMetrics = {
  total: 0,
  by_code: new Map(),
  by_type: new Map(),
  by_route: new Map()
};

export async function afterRun(resultOrError, context) {
  if (isError(resultOrError)) {
    const classified = classifyError(resultOrError);
    
    // Update metrics
    errorMetrics.total++;
    
    incrementCounter(errorMetrics.by_code, classified.code);
    incrementCounter(errorMetrics.by_type, classified.type);
    incrementCounter(errorMetrics.by_route, context.oxian.route);
    
    // Send to external monitoring
    await sendErrorMetric(classified, context);
  }
  
  return resultOrError;
}

function incrementCounter(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

async function sendErrorMetric(classified, context) {
  if (Deno.env.get("MONITORING_ENABLED") === "true") {
    await fetch("https://api.monitoring.com/metrics", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${Deno.env.get("MONITORING_API_KEY")}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        metric: "api.errors",
        value: 1,
        tags: {
          error_type: classified.type,
          error_code: classified.code,
          route: context.oxian.route,
          severity: classified.severity
        },
        timestamp: Date.now()
      })
    });
  }
}
```

## Error Recovery Patterns

### Retry Logic

```ts
export async function GET({ id }, { dependencies }) {
  const { externalAPI } = dependencies;
  
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await externalAPI.fetchData(id);
      return data;
    } catch (error) {
      lastError = error;
      
      // Don't retry client errors
      if (error.statusCode >= 400 && error.statusCode < 500) {
        throw error;
      }
      
      // Wait before retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  // All retries failed
  throw {
    message: "External service unavailable after retries",
    statusCode: 503,
    code: "SERVICE_UNAVAILABLE",
    details: {
      attempts: maxRetries,
      lastError: lastError.message
    }
  };
}
```

### Circuit Breaker

```ts
class CircuitBreaker {
  constructor(
    private threshold = 5,
    private timeout = 60000,
    private resetTimeout = 30000
  ) {}
  
  private failures = 0;
  private state = "closed"; // closed, open, half-open
  private nextAttempt = 0;
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() < this.nextAttempt) {
        throw {
          message: "Circuit breaker is open",
          statusCode: 503,
          code: "CIRCUIT_BREAKER_OPEN"
        };
      } else {
        this.state = "half-open";
      }
    }
    
    try {
      const result = await fn();
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

// Usage
const dbCircuitBreaker = new CircuitBreaker();

export async function GET({ id }) {
  try {
    return await dbCircuitBreaker.execute(async () => {
      return await database.users.findById(id);
    });
  } catch (error) {
    if (error.code === "CIRCUIT_BREAKER_OPEN") {
      // Return cached data or degraded response
      return getCachedUser(id) || {
        message: "Service temporarily unavailable",
        statusCode: 503
      };
    }
    throw error;
  }
}
```

### Graceful Degradation

```ts
export async function GET({ id }, { dependencies }) {
  const { primaryDB, cacheDB, fallbackAPI } = dependencies;
  
  try {
    // Try primary database
    return await primaryDB.users.findById(id);
  } catch (primaryError) {
    console.warn("Primary DB failed, trying cache:", primaryError.message);
    
    try {
      // Try cache
      const cached = await cacheDB.get(`user:${id}`);
      if (cached) {
        return { ...cached, source: "cache" };
      }
    } catch (cacheError) {
      console.warn("Cache failed:", cacheError.message);
    }
    
    try {
      // Try fallback API
      const fallbackData = await fallbackAPI.getUser(id);
      return { ...fallbackData, source: "fallback" };
    } catch (fallbackError) {
      console.error("All sources failed:", fallbackError.message);
    }
    
    // All sources failed
    throw {
      message: "User data temporarily unavailable",
      statusCode: 503,
      code: "ALL_SOURCES_FAILED",
      details: {
        primaryError: primaryError.message,
        cacheError: cacheError?.message,
        fallbackError: fallbackError?.message
      }
    };
  }
}
```

## Testing Error Handling

### Unit Testing Errors

```ts
// tests/error-handling.test.ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { GET } from "../routes/users/[id].ts";

Deno.test("GET /users/[id] throws 404 for invalid ID", () => {
  assertThrows(
    () => GET({ id: "invalid" }, mockContext),
    Error,
    "User not found"
  );
});

Deno.test("GET /users/[id] throws 400 for missing ID", () => {
  const error = assertThrows(() => GET({}, mockContext));
  assertEquals(error.statusCode, 400);
  assertEquals(error.code, "MISSING_ID");
});
```

### Integration Testing

```ts
// tests/integration/error-handling.test.ts
Deno.test("API returns consistent error format", async () => {
  const response = await fetch("http://localhost:8080/users/invalid");
  assertEquals(response.status, 404);
  
  const error = await response.json();
  assertEquals(typeof error.error.message, "string");
  assertEquals(typeof error.error.requestId, "string");
  assertEquals(typeof error.error.timestamp, "string");
});

Deno.test("Rate limiting returns proper headers", async () => {
  // Make requests to trigger rate limit
  for (let i = 0; i < 101; i++) {
    await fetch("http://localhost:8080/test");
  }
  
  const response = await fetch("http://localhost:8080/test");
  assertEquals(response.status, 429);
  assert(response.headers.has("retry-after"));
});
```

## Best Practices

### ✅ Do

- Use consistent error response formats
- Include request IDs for tracking
- Log errors with structured data
- Classify errors by type and severity
- Implement proper HTTP status codes
- Use circuit breakers for external services
- Provide helpful error messages
- Test error scenarios thoroughly

### ❌ Don't

- Don't expose sensitive information in errors
- Don't ignore error logging
- Don't use generic error messages
- Don't let errors bubble up unhandled
- Don't forget to include proper status codes
- Don't log sensitive data in error details
- Don't create inconsistent error formats

## Security Considerations

### Preventing Information Disclosure

```ts
export async function afterRun(resultOrError, context) {
  if (resultOrError instanceof Error) {
    // Never expose stack traces in production
    const isProduction = Deno.env.get("NODE_ENV") === "production";
    
    return {
      error: {
        message: isProduction ? "Internal server error" : resultOrError.message,
        code: "INTERNAL_ERROR",
        requestId: context.requestId,
        timestamp: new Date().toISOString(),
        // Only include stack in development
        ...(isProduction ? {} : { stack: resultOrError.stack })
      }
    };
  }
  
  return resultOrError;
}
```

### Sanitizing Error Details

```ts
function sanitizeErrorDetails(details: any): any {
  if (!details || typeof details !== "object") {
    return details;
  }
  
  const sensitiveFields = ["password", "token", "secret", "key"];
  const sanitized = { ...details };
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = "[REDACTED]";
    }
  }
  
  return sanitized;
}
```

---

Robust error handling is crucial for production APIs. Implement consistent error formats, proper logging, and graceful degradation to create resilient applications.

**Next Steps:**
- [Monitoring Guide](./monitoring.md) - Production monitoring
- [Security Guide](./security.md) - Security best practices
- [Best Practices](./best-practices.md) - Production patterns
