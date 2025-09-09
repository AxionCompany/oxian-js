/**
 * @fileoverview Core type definitions for the Oxian framework.
 * 
 * This module contains the fundamental types used throughout the Oxian framework,
 * including request/response types, handler interfaces, middleware definitions,
 * loader types, and error classes. These types form the foundation of the
 * framework's type system.
 * 
 * @module core/types
 */

/**
 * Represents arbitrary data passed through the request pipeline.
 * 
 * This type is used to represent data that flows through middleware, interceptors,
 * and handlers. It's a flexible record type that can contain any structured data.
 * 
 * @example
 * ```typescript
 * const data: Data = {
 *   userId: "123",
 *   username: "john_doe",
 *   preferences: { theme: "dark" }
 * };
 * ```
 */
export type Data = Record<string, unknown>;

/**
 * Interface for controlling HTTP responses in route handlers.
 * 
 * The ResponseController provides methods for sending responses, streaming data,
 * sending Server-Sent Events (SSE), and manipulating response headers and status.
 * It supports various response modes including JSON responses, streaming, and SSE.
 * 
 * @example
 * ```typescript
 * // Simple JSON response
 * context.response.send({ message: "Hello, world!" });
 * 
 * // Streaming response
 * const writer = context.response.stream();
 * writer("chunk 1");
 * writer("chunk 2");
 * writer.close?.();
 * 
 * // Server-Sent Events
 * const sse = context.response.sse();
 * sse.send({ time: Date.now() }, { event: "time-update" });
 * ```
 */
export type ResponseController = {
  send: (body: unknown, init?: Partial<{ status: number; headers: Record<string, string>; statusText: string }>) => void;
  // If called with init only (or no arg), returns a writer function for incremental streaming.
  // If called with a string/Uint8Array, writes once and closes the stream (no return value).
  stream: (
    initOrChunk?: Partial<{ status: number; headers: Record<string, string>; statusText: string }> | Uint8Array | string,
  ) => (((chunk: Uint8Array | string) => void) & { close?: () => void; done?: Promise<void> }) | void;
  sse: (init?: Partial<{ status: number; headers: Record<string, string>; retry?: number; keepOpen?: boolean }>) => {
    send: (data: unknown, opts?: { event?: string; id?: string; retry?: number }) => void;
    comment: (text: string) => void;
    close: () => void;
    done: Promise<void>;
  };
  status: (code: number) => void;
  headers: (headers: Record<string, string>) => void;
  statusText: (text: string) => void;
};

/**
 * Request context object passed to handlers, middleware, and interceptors.
 * 
 * The Context object contains all information about the current request,
 * including request details, dependencies, response controller, and internal
 * Oxian metadata. It serves as the primary interface for accessing request
 * data and controlling responses.
 * 
 * @example
 * ```typescript
 * export async function GET(data: Data, context: Context) {
 *   const { method, url } = context.request;
 *   const userId = context.request.pathParams.id;
 *   const database = context.dependencies.database;
 *   
 *   context.response.send({ userId, method, url });
 * }
 * ```
 */
export type Context = {
  requestId: string;
  request: {
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
  dependencies: Record<string, unknown>;
  response: ResponseController;
  oxian: { route: string; startedAt: number };
};

/**
 * Function signature for route handlers.
 * 
 * Handlers are the core functions that process HTTP requests. They receive
 * processed data and a context object, and can return responses synchronously
 * or asynchronously. Handlers are typically exported from route files using
 * HTTP method names (GET, POST, etc.).
 * 
 * @param data - Processed request data (path params, query params, body)
 * @param context - Request context containing request info and response controller
 * @returns Response data, void, or a Promise resolving to either
 * 
 * @example
 * ```typescript
 * export const GET: Handler = async (data, context) => {
 *   const user = await getUserById(data.id);
 *   return { user };
 * };
 * 
 * export const POST: Handler = (data, context) => {
 *   context.response.send({ created: true }, { status: 201 });
 * };
 * ```
 */
export type Handler = (data: Data, context: Context) => Promise<unknown | void> | unknown | void;
/**
 * Return type for middleware functions.
 * 
 * Middleware can optionally modify the data and context objects by returning
 * an object with data and/or context properties. If nothing is returned,
 * the original data and context are passed through unchanged.
 * 
 * @example
 * ```typescript
 * // Modify data
 * return { data: { ...data, userId: "123" } };
 * 
 * // Modify context
 * return { context: { dependencies: { ...context.dependencies, auth: user } } };
 * 
 * // Modify both
 * return { 
 *   data: { ...data, processed: true },
 *   context: { dependencies: { ...context.dependencies, timestamp: Date.now() } }
 * };
 * ```
 */
export type MiddlewareResult = { data?: Data; context?: Partial<Context>; params?: unknown } | void | Promise<{ data?: Data; context?: Partial<Context>, params?: unknown } | void>;
/**
 * Function signature for middleware.
 * 
 * Middleware functions execute before route handlers and can modify the request
 * data and context. They are useful for authentication, logging, data validation,
 * and other cross-cutting concerns.
 * 
 * @param data - Current request data
 * @param context - Request context
 * @returns Modified data/context or void
 * 
 * @example
 * ```typescript
 * export const middleware: Middleware = async (data, context) => {
 *   const token = context.request.headers.get("authorization");
 *   const user = await authenticateToken(token);
 *   
 *   return {
 *     data: { ...data, userId: user.id },
 *     context: { dependencies: { ...context.dependencies, user } }
 *   };
 * };
 * ```
 */
export type Middleware = (data: Data, context: Context) => MiddlewareResult;

/**
 * Configuration object for request/response interceptors.
 * 
 * Interceptors provide hooks that run before and after route handler execution.
 * They are useful for logging, error handling, response transformation,
 * and other cross-cutting concerns that need to wrap handler execution.
 * 
 * @example
 * ```typescript
 * export const interceptors: Interceptors = {
 *   beforeRun: (data, context) => {
 *     console.log(`Processing ${context.request.method} ${context.request.url}`);
 *     return { data: { ...data, startTime: Date.now() } };
 *   },
 *   afterRun: (result, context) => {
 *     const duration = Date.now() - context.request.startTime;
 *     console.log(`Request completed in ${duration}ms`);
 *   }
 * };
 * ```
 */
export type Interceptors = {
  beforeRun?: (data: Data, context: Context) => MiddlewareResult;
  afterRun?: (resultOrError: unknown, context: Context) => unknown | void | Promise<unknown | void>;
};

/**
 * Supported media types for module loading.
 * 
 * This type defines the file types that can be loaded and processed by
 * Oxian's module loader system. Each type corresponds to a specific
 * JavaScript/TypeScript file format.
 */
export type LoaderMediaType = "ts" | "js" | "tsx" | "jsx" | "json";

/**
 * Interface for module loaders that can fetch code from different sources.
 * 
 * Loaders enable Oxian to load modules from various sources like local files,
 * GitHub repositories, HTTP endpoints, etc. Each loader implements this
 * interface to provide a consistent API for module loading.
 * 
 * @example
 * ```typescript
 * const githubLoader: Loader = {
 *   scheme: "github",
 *   canHandle: (url) => url.hostname === "github.com",
 *   load: async (url) => {
 *     const content = await fetchFromGitHub(url);
 *     return { content, mediaType: "ts" };
 *   }
 * };
 * ```
 */
export type Loader = {
  scheme: "local" | "github" | "http" | "https" | "file";
  canHandle: (url: URL) => boolean;
  load: (url: URL) => Promise<{ content: string; mediaType: LoaderMediaType }>;
  listDir?: (url: URL) => Promise<string[]>;
  stat?: (url: URL) => Promise<{ isFile: boolean; mtime?: number }>;
  cacheKey?: (url: URL) => string;
};

/**
 * HTTP error class for Oxian applications.
 * 
 * This error class provides structured HTTP error handling with status codes,
 * error codes, and additional details. It's designed to be thrown from handlers,
 * middleware, or interceptors when HTTP-specific errors occur.
 * 
 * @example
 * ```typescript
 * // Simple HTTP error
 * throw new OxianHttpError("User not found", { statusCode: 404 });
 * 
 * // Error with code and details
 * throw new OxianHttpError("Validation failed", {
 *   statusCode: 400,
 *   code: "VALIDATION_ERROR",
 *   details: { field: "email", reason: "invalid format" }
 * });
 * ```
 */
export class OxianHttpError extends Error {
  code?: string;
  statusCode: number;
  statusText?: string;
  details?: unknown;
  constructor(message: string, opts?: { code?: string; statusCode?: number; statusText?: string; details?: unknown }) {
    super(message);
    this.name = "OxianHttpError";
    this.code = opts?.code;
    this.statusCode = opts?.statusCode ?? 500;
    this.statusText = opts?.statusText;
    this.details = opts?.details;
  }
} 