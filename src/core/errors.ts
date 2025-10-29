/**
 * @fileoverview HTTP error classes for Oxian applications.
 * 
 * @module core/errors
 */

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
  constructor(
    message: string,
    opts?: {
      code?: string;
      statusCode?: number;
      statusText?: string;
      details?: unknown;
    },
  ) {
    super(message);
    this.name = "OxianHttpError";
    this.code = opts?.code;
    this.statusCode = opts?.statusCode ?? 500;
    this.statusText = opts?.statusText;
    this.details = opts?.details;
  }
}

