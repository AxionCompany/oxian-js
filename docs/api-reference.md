# 📖 API Reference - Complete TypeScript Reference

This comprehensive reference covers all types, interfaces, and APIs available in
Oxian. Use this as your go-to reference for TypeScript development with Oxian.

## Core Types

### Data

The `Data` type represents merged request data from path parameters, query
parameters, and request body.

```typescript
export type Data = Record<string, unknown>;
```

**Example Usage:**

```typescript
export function GET({ id, limit, name }: Data) {
  // id from path params: /users/:id
  // limit from query: ?limit=10
  // name from body: {"name": "John"}
}
```

### Context

The `Context` object provides request details and response utilities.

```typescript
export type Context = {
  requestId: string;
  request: RequestDetails;
  dependencies: Record<string, unknown>;
  response: ResponseController;
  oxian: OxianInternals;
  [key: string]: unknown; // Allow middleware to add properties
};
```

### RequestDetails

```typescript
type RequestDetails = {
  method: string;
  url: string;
  headers: Headers;
  pathParams: Record<string, string>;
  queryParams: URLSearchParams;
  query: Record<string, string | string[]>;
  body: unknown;
  rawBody?: Uint8Array;
  raw: Request;
};
```

**Properties:**

- `method` - HTTP method (GET, POST, etc.)
- `url` - Full request URL
- `headers` - Request headers
- `pathParams` - Path parameters as object
- `queryParams` - Raw URLSearchParams
- `query` - Parsed query parameters
- `body` - Parsed request body
- `raw` - Original Deno Request object

### ResponseController

```typescript
export type ResponseController = {
  send: (body: unknown, init?: ResponseInit) => void;
  stream: (
    initOrChunk?: StreamInit | Uint8Array | string,
  ) => StreamWriter | void;
  sse: (init?: SSEInit) => SSEController;
  status: (code: number) => void;
  headers: (headers: Record<string, string>) => void;
  statusText: (text: string) => void;
};
```

#### ResponseInit

```typescript
type ResponseInit = Partial<{
  status: number;
  headers: Record<string, string>;
  statusText: string;
}>;
```

#### StreamInit

```typescript
type StreamInit = Partial<{
  status: number;
  headers: Record<string, string>;
  statusText: string;
}>;
```

#### StreamWriter

```typescript
type StreamWriter = ((chunk: Uint8Array | string) => void) & {
  close?: () => void;
  done?: Promise<void>;
};
```

#### SSEInit

```typescript
type SSEInit = Partial<{
  status: number;
  headers: Record<string, string>;
  retry?: number;
  keepOpen?: boolean;
}>;
```

#### SSEController

```typescript
type SSEController = {
  send: (data: unknown, opts?: SSEEventOptions) => void;
  comment: (text: string) => void;
  close: () => void;
  done: Promise<void>;
};
```

#### SSEEventOptions

```typescript
type SSEEventOptions = {
  event?: string;
  id?: string;
  retry?: number;
};
```

### OxianInternals

```typescript
type OxianInternals = {
  route: string;
  startedAt: number;
  [key: string]: unknown; // Allow extensions
};
```

## Handler Types

### Handler

```typescript
export type Handler = (
  data: Data,
  context: Context,
) => Promise<unknown | void> | unknown | void;
```

**Return Types:**

- `object | array` - JSON response (200)
- `string` - Text response (200)
- `Uint8Array` - Binary response (200)
- `Response` - Full control over response
- `void | undefined` - Empty response (200)

**Example:**

```typescript
export const GET: Handler = async ({ id }, { dependencies }) => {
  const { userService } = dependencies;
  return await userService.findById(id);
};
```

### Middleware

```typescript
export type Middleware = (
  data: Data,
  context: Context,
) => MiddlewareResult;

export type MiddlewareResult =
  | {
    data?: Data;
    context?: Partial<Context>;
  }
  | void
  | Promise<
    {
      data?: Data;
      context?: Partial<Context>;
    } | void
  >;
```

**Example:**

```typescript
export default function middleware(
  data: Data,
  context: Context,
): MiddlewareResult {
  return {
    data: { ...data, timestamp: Date.now() },
    context: { user: getCurrentUser() },
  };
}
```

### Interceptors

```typescript
export type Interceptors = {
  beforeRun?: (data: Data, context: Context) => MiddlewareResult;
  afterRun?: (
    resultOrError: unknown,
    context: Context,
  ) => unknown | void | Promise<unknown | void>;
};
```

**Example:**

```typescript
export async function beforeRun(data: Data, context: Context) {
  // Setup logic
  context.oxian.startedAt = performance.now();
}

export async function afterRun(resultOrError: unknown, context: Context) {
  // Cleanup logic
  const duration = performance.now() - context.oxian.startedAt;
  console.log(`Request took ${duration}ms`);
}
```

## Error Types

### OxianHttpError

```typescript
export class OxianHttpError extends Error {
  code?: string;
  statusCode: number;
  statusText?: string;
  details?: unknown;

  constructor(
    message: string,
    opts?: {
      code?: string;
      statusCode?: number;
      statusText?: string;
      details?: unknown;
    },
  );
}
```

**Example:**

```typescript
import { OxianHttpError } from "jsr:@oxian/oxian-js/types";

throw new OxianHttpError("User not found", {
  statusCode: 404,
  code: "USER_NOT_FOUND",
  details: { userId: id },
});
```

### Error Objects

You can also throw plain objects for simpler error handling:

```typescript
type ErrorObject = {
  message: string;
  statusCode?: number;
  statusText?: string;
  code?: string;
  details?: unknown;
  headers?: Record<string, string>;
};
```

**Example:**

```typescript
throw {
  message: "Validation failed",
  statusCode: 400,
  code: "VALIDATION_ERROR",
  details: { errors: ["Email is required"] },
};
```

## Configuration Types

### OxianConfig

```typescript
export type OxianConfig = {
  root?: string;
  basePath?: string;
  server?: ServerConfig;
  routing?: RoutingConfig;
  runtime?: RuntimeConfig;
  security?: SecurityConfig;
  logging?: LoggingConfig;
  loaders?: LoadersConfig;
};
```

### ServerConfig

```typescript
type ServerConfig = {
  port?: number;
  hostname?: string;
  tls?: {
    certFile: string;
    keyFile: string;
  };
};
```

### RoutingConfig

```typescript
type RoutingConfig = {
  routesDir?: string;
  trailingSlash?: "always" | "never" | "preserve";
  discovery?: "eager" | "lazy";
  caseSensitive?: boolean;
  basePath?: string;
};
```

### RuntimeConfig

```typescript
type RuntimeConfig = {
  hotReload?: boolean;
  watchGlobs?: string[];
  dependencies?: DependenciesConfig;
  hv?: HypervisorConfig;
};
```

### DependenciesConfig

```typescript
type DependenciesConfig = {
  initial?: Record<string, unknown>;
  bootstrapModule?: string;
  merge?: "shallow" | "deep" | "replace";
  readonly?: string[];
};
```

### HypervisorConfig

```typescript
type HypervisorConfig = {
  enabled?: boolean;
  workers?: number | "auto";
  strategy?: "round_robin" | "least_busy" | "sticky";
  stickyHeader?: string;
  workerBasePort?: number;
  proxy?: ProxyConfig;
  health?: HealthConfig;
  autoscale?: AutoscaleConfig;
  denoConfig?: string;
  timeouts?: TimeoutsConfig;
  projects?: Record<string, ProjectConfig>;
  select?: SelectionRule[];
};
```

### ProxyConfig

```typescript
type ProxyConfig = {
  timeoutMs?: number;
  passRequestId?: boolean;
};
```

### HealthConfig

```typescript
type HealthConfig = {
  path?: string;
  intervalMs?: number;
  timeoutMs?: number;
};
```

### AutoscaleConfig

```typescript
type AutoscaleConfig = {
  enabled?: boolean;
  min?: number;
  max?: number;
  targetInflightPerWorker?: number;
  maxAvgLatencyMs?: number;
  scaleUpCooldownMs?: number;
  scaleDownCooldownMs?: number;
  idleTtlMs?: number;
};
```

### SecurityConfig

```typescript
type SecurityConfig = {
  cors?: CORSConfig;
  defaultHeaders?: Record<string, string>;
  scrubHeaders?: string[];
};
```

### CORSConfig

```typescript
type CORSConfig = {
  allowedOrigins?: string[];
  allowedHeaders?: string[];
  allowedMethods?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
};
```

### LoggingConfig

```typescript
type LoggingConfig = {
  level?: "debug" | "info" | "warn" | "error";
  requestIdHeader?: string;
  structured?: boolean;
  format?: "json" | "pretty";
  requests?: boolean;
};
```

### LoadersConfig

```typescript
type LoadersConfig = {
  local?: LocalLoaderConfig;
  github?: GitHubLoaderConfig;
  http?: HTTPLoaderConfig;
};
```

### LocalLoaderConfig

```typescript
type LocalLoaderConfig = {
  enabled?: boolean;
};
```

### GitHubLoaderConfig

```typescript
type GitHubLoaderConfig = {
  enabled?: boolean;
  tokenEnv?: string;
  cacheTtlSec?: number;
};
```

### HTTPLoaderConfig

```typescript
type HTTPLoaderConfig = {
  enabled?: boolean;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
};
```

## Loader Types

### Loader Interface

```typescript
export interface Loader {
  scheme: string;
  canHandle: (url: URL) => boolean;
  load: (url: URL) => Promise<LoadResult>;
  listDir?: (url: URL) => Promise<string[]>;
  stat?: (url: URL) => Promise<StatResult>;
  cacheKey?: (url: URL) => string;
}
```

### LoadResult

```typescript
type LoadResult = {
  content: string;
  mediaType: LoaderMediaType;
};
```

### LoaderMediaType

```typescript
export type LoaderMediaType = "ts" | "js" | "tsx" | "jsx" | "json";
```

### StatResult

```typescript
type StatResult = {
  isFile: boolean;
  mtime?: number;
};
```

## Utility Types

### EffectiveConfig

The resolved configuration after merging defaults, files, and environment
variables.

```typescript
export type EffectiveConfig = Required<OxianConfig> & {
  // All optional properties become required with defaults
};
```

### Route

```typescript
type Route = {
  pattern: string;
  methods: string[];
  filePath: string;
  dynamic: boolean;
  catchAll: boolean;
};
```

## Helper Functions

### createTypedHandler

Create type-safe handlers with validation:

```typescript
export function createTypedHandler<TData, TResponse>(
  handler: (data: TData, context: Context) => Promise<TResponse> | TResponse,
  validator?: (data: unknown) => TData,
): Handler {
  return async (data: Data, context: Context): Promise<TResponse> => {
    const validatedData = validator ? validator(data) : data as TData;
    return await handler(validatedData, context);
  };
}
```

**Example:**

```typescript
interface CreateUserData {
  name: string;
  email: string;
}

interface User {
  id: string;
  name: string;
  email: string;
}

const createUserHandler = createTypedHandler<CreateUserData, User>(
  async (data, { dependencies }) => {
    const { userService } = dependencies;
    return await userService.create(data);
  },
  (data) => {
    // Validation logic
    if (!data.name || !data.email) {
      throw new Error("Name and email required");
    }
    return data as CreateUserData;
  },
);

export const POST = createUserHandler;
```

## Environment Variables

### Standard Environment Variables

Oxian recognizes these environment variables:

```typescript
// Server configuration
process.env.PORT; // Server port
process.env.HOST; // Server hostname

// Runtime configuration
process.env.NODE_ENV; // Environment (development/production/test)
process.env.OXIAN_HOT_RELOAD; // Enable hot reload (true/false)
process.env.OXIAN_LOG_LEVEL; // Log level (debug/info/warn/error)

// Loaders
process.env.GITHUB_TOKEN; // GitHub API token
process.env.OXIAN_SOURCE; // Default source location

// Security
process.env.JWT_SECRET; // JWT signing secret
process.env.CORS_ORIGINS; // Allowed CORS origins (comma-separated)

// Database
process.env.DATABASE_URL; // Database connection string
process.env.REDIS_URL; // Redis connection string

// Monitoring
process.env.SENTRY_DSN; // Sentry error tracking
process.env.DATADOG_API_KEY; // DataDog monitoring
```

## CLI Types

### CLI Arguments

```typescript
type CLIArgs = {
  config?: string; // Configuration file path
  source?: string; // Source location
  port?: number; // Server port
  hostname?: string; // Server hostname
  hypervisor?: boolean; // Enable hypervisor
  "deno-config"?: string; // Deno configuration file
  help?: boolean; // Show help
  debug?: boolean; // Enable debug mode
};
```

### CLI Commands

```typescript
type CLICommand = "start" | "dev" | "routes" | "help";
```

## Extension Points

### Custom Middleware

```typescript
export interface MiddlewareFactory {
  create(config: any): Middleware;
}
```

### Custom Loaders

```typescript
export interface LoaderFactory {
  create(config: any): Loader;
}
```

### Custom Error Handlers

```typescript
export interface ErrorHandler {
  handle(error: unknown, context: Context): unknown;
}
```

## Examples

### Complete Handler with Types

```typescript
import type { Context, Data, Handler } from "jsr:@oxian/oxian-js/types";

interface UserQuery {
  id: string;
  include?: string[];
}

interface User {
  id: string;
  name: string;
  email: string;
  posts?: Post[];
}

interface UserService {
  findById(id: string, include?: string[]): Promise<User | null>;
}

interface Dependencies {
  userService: UserService;
}

export const GET: Handler = async (data: Data, context: Context) => {
  const { id, include } = data as UserQuery;
  const { userService } = context.dependencies as Dependencies;

  if (!id) {
    throw {
      message: "User ID is required",
      statusCode: 400,
      code: "MISSING_USER_ID",
    };
  }

  const user = await userService.findById(id, include);
  if (!user) {
    throw {
      message: "User not found",
      statusCode: 404,
      code: "USER_NOT_FOUND",
      details: { userId: id },
    };
  }

  return user;
};
```

### Typed Middleware

```typescript
import type { Context, Data, Middleware } from "jsr:@oxian/oxian-js/types";

interface AuthenticatedContext extends Context {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
}

const authMiddleware: Middleware = async (data: Data, context: Context) => {
  const token = context.request.headers.get("authorization")?.replace(
    "Bearer ",
    "",
  );

  if (!token) {
    throw {
      message: "Authentication required",
      statusCode: 401,
      code: "AUTHENTICATION_REQUIRED",
    };
  }

  const user = await verifyToken(token);
  if (!user) {
    throw {
      message: "Invalid token",
      statusCode: 401,
      code: "INVALID_TOKEN",
    };
  }

  return {
    context: { user },
  };
};

export default authMiddleware;
```

### Typed Dependencies

```typescript
// types/dependencies.ts
export interface AppDependencies {
  database: Database;
  cache: CacheService;
  logger: Logger;
  userService: UserService;
  emailService: EmailService;
}

// routes/dependencies.ts
import type { AppDependencies } from "../types/dependencies.ts";

export default async function (): Promise<AppDependencies> {
  const database = await createDatabase();
  const cache = createCacheService();
  const logger = createLogger();

  return {
    database,
    cache,
    logger,
    userService: createUserService(database, cache),
    emailService: createEmailService(),
  };
}

// routes/users.ts
import type { Handler } from "jsr:@oxian/oxian-js/types";
import type { AppDependencies } from "../types/dependencies.ts";

export const GET: Handler = async (data, context) => {
  const { userService } = context.dependencies as AppDependencies;
  return await userService.findAll();
};
```

---

This API reference provides complete type information for building robust,
type-safe applications with Oxian. Use TypeScript's autocomplete and type
checking to catch errors early and improve development experience.

**Next Steps:**

- [Getting Started](./getting-started.md) - Build your first API
- [Best Practices](./best-practices.md) - Production patterns
- [Examples Repository](https://github.com/oxian-org/examples) - Real-world
  examples
