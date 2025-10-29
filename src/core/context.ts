/**
 * @fileoverview Context and ResponseController types for Oxian request handling.
 * 
 * @module core/context
 */

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
  send: (
    body: unknown,
    init?: Partial<
      { status: number; headers: Record<string, string>; statusText: string }
    >,
  ) => void;
  // If called with init only (or no arg), returns a writer function for incremental streaming.
  // If called with a string/Uint8Array, writes once and closes the stream (no return value).
  stream: (
    initOrChunk?:
      | Partial<
        { status: number; headers: Record<string, string>; statusText: string }
      >
      | Uint8Array
      | string,
  ) =>
    | (((chunk: Uint8Array | string) => void) & {
      close?: () => void;
      done?: Promise<void>;
    })
    | void;
  sse: (
    init?: Partial<
      {
        status: number;
        headers: Record<string, string>;
        retry?: number;
        keepOpen?: boolean;
      }
    >,
  ) => {
    send: (
      data: unknown,
      opts?: { event?: string; id?: string; retry?: number },
    ) => void;
    comment: (text: string) => void;
    close: () => void;
    done: Promise<void>;
  };
  status: (code: number) => void;
  headers: (headers: Record<string, string>) => void;
  statusText: (text: string) => void;
  /**
   * Sets an HTTP redirect with a Location header and status code (default 302).
   * Body remains empty unless previously set.
   */
  redirect: (url: string, status?: 301 | 302 | 303 | 307 | 308) => void;
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

