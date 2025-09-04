# 🎯 Handlers - Route Handler Functions

Handlers are the core functions that process HTTP requests in Oxian. They receive parsed request data and context, then return responses or throw errors. This guide covers everything about writing effective, type-safe handlers.

## Handler Signature

Every handler function follows the same signature:

```ts
export async function METHOD(
  data: Data,      // Merged request data (path + query + body)
  context: Context // Request context and utilities
): Promise<unknown | void> | unknown | void {
  // Handler logic here
  return response; // or throw error
}
```

### Supported HTTP Methods

Export functions named after HTTP methods:

```ts
// routes/users.ts
export function GET(data, context) {
  return { users: [] };
}

export function POST(data, context) {
  return { created: true };
}

export function PUT(data, context) {
  return { updated: true };
}

export function PATCH(data, context) {
  return { patched: true };
}

export function DELETE(data, context) {
  return { deleted: true };
}

// Fallback for unsupported methods
export default function(data, context) {
  throw { 
    message: `Method ${context.request.method} not allowed`,
    statusCode: 405 
  };
}
```

## Data Parameter

The `data` parameter contains merged request data with this precedence:

1. **Path parameters** (highest priority)
2. **Query parameters**
3. **Request body** (lowest priority)

### Path Parameters

```ts
// routes/users/[id].ts
export function GET({ id }) {
  // URL: /users/123 → id = "123"
  return { user: { id, name: `User ${id}` } };
}

// routes/users/[id]/posts/[postId].ts
export function GET({ id, postId }) {
  // URL: /users/123/posts/456 → id = "123", postId = "456"
  return { user: id, post: postId };
}
```

### Query Parameters

```ts
// routes/search.ts
export function GET({ q, limit = 10, sort = "created" }) {
  // URL: /search?q=hello&limit=5&sort=updated
  // → q = "hello", limit = "5", sort = "updated"
  
  return {
    query: q,
    limit: parseInt(limit),
    sort,
    results: []
  };
}
```

### Request Body

```ts
// routes/users.ts
export function POST({ name, email, age }) {
  // Body: {"name":"John","email":"john@example.com","age":25}
  // → name = "John", email = "john@example.com", age = 25
  
  return { 
    id: Math.random().toString(36),
    name,
    email,
    age: age ? parseInt(age) : null
  };
}
```

### Request Body Parsing Details

Oxian parses bodies based on `Content-Type` and merges into `data` with the precedence: path > query > body.

- **application/json**: Parsed JSON. Empty body → `undefined`.
- **text/plain**: Raw string.
- **application/x-www-form-urlencoded**: Key/value object where duplicate keys produce arrays of strings.
- **multipart/form-data**:
  - Text fields are strings; duplicate keys produce arrays of strings.
  - File fields are transformed into objects that include base64-encoded content and metadata:
    ```ts
    type UploadedFile = {
      filename: string;
      contentType: string;
      size: number;
      base64: string; // file bytes encoded as base64
    };
    ```
  - Multiple files for the same field become arrays of `UploadedFile`.

Example handler receiving multipart form-data:

```ts
// routes/assets.ts
export function POST({ title, file }) {
  // title: string | string[]
  // file: UploadedFile | UploadedFile[]
  const f = Array.isArray(file) ? file[0] : file;
  return {
    title: Array.isArray(title) ? title[0] : title,
    filename: f?.filename,
    bytes: f?.size,
    contentType: f?.contentType
  };
}
```

### Parameter Precedence Example

```ts
// routes/users/[id].ts
export function PUT({ id, name, email }) {
  // URL: /users/123?id=456
  // Body: {"id": 789, "name": "John", "email": "john@example.com"}
  
  // Result: id = "123" (path wins), name = "John", email = "john@example.com"
  
  return { id, name, email };
}
```

## Context Parameter

The `context` parameter provides request details and utilities:

```ts
export function GET(data, context) {
  const {
    requestId,        // Unique request identifier
    request: {        // Request object
      method,         // HTTP method
      url,            // Full URL
      headers,        // Headers object
      pathParams,     // Path parameters object
      queryParams,    // URLSearchParams object  
      query,          // Parsed query object
      body,           // Parsed body
      raw             // Original Request object
    },
    dependencies,     // Injected dependencies
    response: {       // Response utilities
      send,           // Send response manually
      stream,         // Start streaming
      sse,            // Server-sent events
      status,         // Set status code
      headers,        // Set headers
      statusText      // Set status text
    },
    oxian: {         // Framework internals
      route,          // Matched route pattern
      startedAt       // Request start time
    }
  } = context;
  
  return { requestId, method, route };
}
```

## Response Patterns

### Return Values

Handlers can return different types of values:

```ts
// JSON object (most common)
export function GET() {
  return { message: "Hello world" }; // → 200 application/json
}

// String response
export function GET() {
  return "Plain text response"; // → 200 text/plain
}

// Array response
export function GET() {
  return [1, 2, 3]; // → 200 application/json
}

// Uint8Array response
export function GET() {
  return new TextEncoder().encode("Binary data"); // → 200 application/octet-stream
}

// Response object (full control)
export function GET() {
  return new Response("Custom response", {
    status: 201,
    headers: { "content-type": "text/plain" }
  });
}

// Void/undefined (empty response)
export function DELETE() {
  // Perform deletion...
  return; // → 200 with empty body
}
```

### Manual Response Control

Use `context.response` for fine-grained control:

```ts
export function POST(data, { response }) {
  // Set status code
  response.status(201);
  
  // Set headers
  response.headers({
    "location": "/users/123",
    "x-custom": "header"
  });
  
  // Send response
  response.send({ 
    created: true,
    id: "123"
  });
}
```

### Status Code Patterns

```ts
// Success responses
export function GET() {
  return data; // → 200 OK
}

export function POST({ /* data */ }, { response }) {
  response.status(201); // → 201 Created
  return { created: true };
}

export function PUT() {
  return { updated: true }; // → 200 OK
}

export function DELETE() {
  return; // → 200 OK (empty body)
}

// No content
export function DELETE({ id }, { response }) {
  deleteUser(id);
  response.status(204); // → 204 No Content
  return;
}
```

## Error Handling

### Throwing Errors

Throw objects with error details:

```ts
export function GET({ id }) {
  if (!id) {
    throw {
      message: "ID parameter required",
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

### Using OxianHttpError

```ts
import { OxianHttpError } from "jsr:@oxian/oxian-js/types";

export function GET({ id }) {
  if (!id) {
    throw new OxianHttpError("ID required", {
      statusCode: 400,
      code: "MISSING_ID",
      details: { parameter: "id" }
    });
  }
  
  return { user: { id } };
}
```

### Regular Errors

```ts
export function GET({ id }) {
  try {
    const data = JSON.parse(someJsonString);
    return data;
  } catch (error) {
    // Regular errors become 500 responses
    throw new Error("Failed to parse data");
  }
}
```

## Advanced Handler Patterns

### Conditional Responses

```ts
export function GET({ format = "json" }, { response }) {
  const data = { message: "Hello world" };
  
  switch (format) {
    case "xml":
      return new Response(
        `<response><message>${data.message}</message></response>`,
        { headers: { "content-type": "application/xml" } }
      );
      
    case "csv":
      return new Response(
        "message\nHello world",
        { headers: { "content-type": "text/csv" } }
      );
      
    default:
      return data; // JSON
  }
}
```

### Content Negotiation

```ts
export function GET(data, { request }) {
  const accept = request.headers.get("accept");
  const userData = { id: 1, name: "John" };
  
  if (accept?.includes("application/xml")) {
    return new Response(
      `<user><id>${userData.id}</id><name>${userData.name}</name></user>`,
      { headers: { "content-type": "application/xml" } }
    );
  }
  
  if (accept?.includes("text/csv")) {
    return new Response(
      `id,name\n${userData.id},${userData.name}`,
      { headers: { "content-type": "text/csv" } }
    );
  }
  
  return userData; // Default JSON
}
```

### File Uploads

```ts
export async function POST(data, { request }) {
  const formData = await request.raw.formData();
  const file = formData.get("file") as File;
  
  if (!file) {
    throw { message: "No file uploaded", statusCode: 400 };
  }
  
  // Validate file type
  if (!file.type.startsWith("image/")) {
    throw { message: "Only images allowed", statusCode: 400 };
  }
  
  // Save file
  const filename = `uploads/${Date.now()}-${file.name}`;
  await Deno.writeFile(filename, new Uint8Array(await file.arrayBuffer()));
  
  return {
    uploaded: true,
    filename: file.name,
    size: file.size,
    type: file.type,
    url: `/files/${filename}`
  };
}
```

### File Downloads

```ts
export async function GET({ filename }, { response }) {
  const filePath = `./uploads/${filename}`;
  
  try {
    const file = await Deno.open(filePath, { read: true });
    const stat = await file.stat();
    
    response.headers({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": stat.size.toString()
    });
    
    // Stream file
    return new Response(file.readable);
  } catch {
    throw { message: "File not found", statusCode: 404 };
  }
}
```

### Async Operations

```ts
export async function GET({ id }, { dependencies }) {
  const { database, cache } = dependencies;
  
  // Check cache first
  const cached = await cache.get(`user:${id}`);
  if (cached) {
    return { ...cached, fromCache: true };
  }
  
  // Fetch from database
  const user = await database.users.findById(id);
  if (!user) {
    throw { message: "User not found", statusCode: 404 };
  }
  
  // Cache result
  await cache.set(`user:${id}`, user, { ttl: 300 });
  
  return user;
}
```

### Batch Operations

```ts
export async function POST({ users }, { dependencies }) {
  const { database } = dependencies;
  
  if (!Array.isArray(users)) {
    throw { message: "Expected array of users", statusCode: 400 };
  }
  
  if (users.length > 100) {
    throw { message: "Too many users (max 100)", statusCode: 400 };
  }
  
  const results = [];
  const errors = [];
  
  for (let i = 0; i < users.length; i++) {
    try {
      const user = await database.users.create(users[i]);
      results.push({ index: i, user });
    } catch (error) {
      errors.push({ index: i, error: error.message });
    }
  }
  
  return {
    created: results.length,
    errors: errors.length,
    results,
    errors
  };
}
```

## Validation in Handlers

### Manual Validation

```ts
export function POST({ name, email, age }) {
  // Validate required fields
  if (!name || typeof name !== "string") {
    throw { message: "Name is required", statusCode: 400 };
  }
  
  if (!email || typeof email !== "string" || !email.includes("@")) {
    throw { message: "Valid email is required", statusCode: 400 };
  }
  
  // Validate optional fields
  if (age !== undefined && (typeof age !== "number" || age < 0 || age > 150)) {
    throw { message: "Age must be between 0 and 150", statusCode: 400 };
  }
  
  return createUser({ name, email, age });
}
```

### Schema Validation

```ts
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const UserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().min(0).max(150).optional()
});

export function POST(data) {
  try {
    const validatedData = UserSchema.parse(data);
    return createUser(validatedData);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw {
        message: "Validation failed",
        statusCode: 400,
        details: error.errors
      };
    }
    throw error;
  }
}
```

## Testing Handlers

### Unit Testing

```ts
// tests/handlers/users.test.ts
import { assertEquals, assertThrows } from "https://deno.land/std@0.210.0/assert/mod.ts";
import { GET, POST } from "../../routes/users.ts";

const mockContext = {
  requestId: "test-123",
  dependencies: {
    database: {
      users: {
        findAll: () => [{ id: 1, name: "John" }],
        create: (data) => ({ id: 2, ...data })
      }
    }
  }
};

Deno.test("GET /users returns user list", async () => {
  const result = await GET({}, mockContext);
  
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "John");
});

Deno.test("POST /users creates user", async () => {
  const userData = { name: "Jane", email: "jane@example.com" };
  const result = await POST(userData, mockContext);
  
  assertEquals(result.id, 2);
  assertEquals(result.name, "Jane");
});

Deno.test("POST /users validates required fields", () => {
  assertThrows(() => {
    POST({}, mockContext);
  });
});
```

### Integration Testing

```ts
// tests/integration/users.test.ts
Deno.test("User API integration", async () => {
  // Test creating user
  const createResponse = await fetch("http://localhost:8080/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "John", email: "john@example.com" })
  });
  
  assertEquals(createResponse.status, 200);
  const created = await createResponse.json();
  
  // Test getting user
  const getResponse = await fetch(`http://localhost:8080/users/${created.id}`);
  assertEquals(getResponse.status, 200);
  
  const user = await getResponse.json();
  assertEquals(user.name, "John");
});
```

## TypeScript Integration

### Typed Handlers

```ts
import type { Context, Data, Handler } from "jsr:@oxian/oxian-js/types";

interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

interface CreateUserData {
  name: string;
  email: string;
}

interface UserDatabase {
  findById(id: string): Promise<User | null>;
  create(data: CreateUserData): Promise<User>;
}

interface Dependencies {
  database: { users: UserDatabase };
}

export const GET: Handler = async ({ id }: Data, { dependencies }: Context) => {
  const { database } = dependencies as Dependencies;
  
  const user = await database.users.findById(id);
  if (!user) {
    throw { message: "User not found", statusCode: 404 };
  }
  
  return user;
};

export const POST: Handler = async (data: Data, { dependencies }: Context) => {
  const { database } = dependencies as Dependencies;
  
  const createData: CreateUserData = {
    name: data.name as string,
    email: data.email as string
  };
  
  const user = await database.users.create(createData);
  return user;
};
```

### Generic Handler Utilities

```ts
// utils/handlers.ts
import type { Context, Data } from "jsr:@oxian/oxian-js/types";

export function createTypedHandler<TData, TResponse>(
  handler: (data: TData, context: Context) => Promise<TResponse> | TResponse,
  validator?: (data: unknown) => TData
) {
  return async (data: Data, context: Context): Promise<TResponse> => {
    const validatedData = validator ? validator(data) : data as TData;
    return await handler(validatedData, context);
  };
}

// Usage
const createUserHandler = createTypedHandler<CreateUserData, User>(
  async (data, { dependencies }) => {
    const { database } = dependencies;
    return await database.users.create(data);
  },
  (data) => {
    // Validate and transform data
    return {
      name: String(data.name),
      email: String(data.email)
    };
  }
);

export const POST = createUserHandler;
```

## Best Practices

### ✅ Do

- Keep handlers focused on single responsibilities
- Use proper HTTP status codes
- Validate input data thoroughly
- Handle errors gracefully with meaningful messages
- Use TypeScript for better type safety
- Return consistent response formats
- Document complex handler logic
- Test handlers thoroughly

### ❌ Don't

- Don't put business logic directly in handlers
- Don't ignore error handling
- Don't return inconsistent response formats
- Don't forget to validate input data
- Don't use handlers for non-HTTP concerns
- Don't create overly complex handlers
- Don't ignore proper HTTP semantics

## Handler Examples

### Complete CRUD Handler

```ts
// routes/users/[id].ts
import type { Context, Data } from "jsr:@oxian/oxian-js/types";

export async function GET({ id }: Data, { dependencies }: Context) {
  const { userService } = dependencies;
  
  try {
    const user = await userService.findById(id);
    return user;
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      throw { message: "User not found", statusCode: 404 };
    }
    throw { message: "Failed to fetch user", statusCode: 500 };
  }
}

export async function PUT({ id, ...updates }: Data, { dependencies }: Context) {
  const { userService } = dependencies;
  
  try {
    const user = await userService.update(id, updates);
    return user;
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      throw { message: "User not found", statusCode: 404 };
    }
    if (error.code === "VALIDATION_ERROR") {
      throw { message: "Invalid data", statusCode: 400, details: error.details };
    }
    throw { message: "Failed to update user", statusCode: 500 };
  }
}

export async function DELETE({ id }: Data, { dependencies }: Context) {
  const { userService } = dependencies;
  
  try {
    await userService.delete(id);
    return { deleted: true, id };
  } catch (error) {
    if (error.code === "NOT_FOUND") {
      throw { message: "User not found", statusCode: 404 };
    }
    throw { message: "Failed to delete user", statusCode: 500 };
  }
}
```

---

Handlers are the heart of your Oxian application. Keep them simple, focused, and well-tested. Use the power of TypeScript and Oxian's context system to build robust, type-safe APIs.

**Next Steps:**
- [Middleware](./middleware.md) - Process requests before handlers
- [Interceptors](./interceptors.md) - Add cross-cutting concerns
- [Error Handling](./error-handling.md) - Global error strategies
