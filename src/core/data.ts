/**
 * @fileoverview Data type for Oxian request pipeline.
 * 
 * @module core/data
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

