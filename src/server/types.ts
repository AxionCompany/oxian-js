/**
 * @fileoverview Type definitions for Oxian server internals.
 * 
 * @module server/types
 */

/**
 * Internal response state tracking for the server.
 * 
 * This type tracks the current state of an HTTP response being constructed,
 * including status, headers, body, and streaming state.
 */
export interface ResponseState {
  status: number;
  headers: Headers;
  statusText?: string;
  body?: unknown;
  streamWrite?: (chunk: Uint8Array | string) => void;
  streamClose?: () => void;
  // internal flag to control SSE lifecycle
  sseKeepOpen?: boolean;
  // marker for whether response.send has been invoked
  responded?: boolean;
  // hook for runHandler to observe early send invocation
  onSend?: () => void;
}

