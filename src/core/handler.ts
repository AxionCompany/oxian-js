/**
 * @fileoverview Handler, middleware, and interceptor type definitions.
 * 
 * @module core/handler
 */

import type { Data } from "./data.ts";
import type { Context } from "./context.ts";

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
export type Handler = (
  data: Data,
  context: Context,
) => Promise<unknown | void> | unknown | void;

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
export type MiddlewareResult =
  | { data?: Data; context?: Partial<Context>; params?: unknown }
  | void
  | Promise<
    { data?: Data; context?: Partial<Context>; params?: unknown } | void
  >;

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
  afterRun?: (
    resultOrError: unknown,
    context: Context,
  ) => unknown | void | Promise<unknown | void>;
};

