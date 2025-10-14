/**
 * MCP Authentication Middleware
 * Simple API key-based authentication
 */

import type { Data, Context } from "../../src/types.ts";

export default function(_data: Data, context: Context) {
  // Get the expected API key from environment variable
  const expectedApiKey = Deno.env.get("MCP_API_KEY");

  // If no API key is configured, allow all requests (dev mode)
  if (!expectedApiKey) {
    console.warn("[MCP Auth] Warning: MCP_API_KEY not set - authentication disabled");
    return {};
  }

  // Check for API key in Authorization header
  const authHeader = context.request.headers.get("authorization");
  
  if (!authHeader) {
    throw {
      message: "Missing Authorization header",
      statusCode: 401,
      statusText: "Unauthorized",
    };
  }

  // Support both "Bearer <key>" and direct key formats
  const providedKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (providedKey !== expectedApiKey) {
    throw {
      message: "Invalid API key",
      statusCode: 401,
      statusText: "Unauthorized",
    };
  }

  // Authentication successful
  return {};
}

