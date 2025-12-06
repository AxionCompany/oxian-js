/**
 * @fileoverview MCP (Model Context Protocol) utilities for Oxian framework.
 * 
 * This module provides helper functions to build HTTP-based MCP servers
 * following the JSON-RPC 2.0 protocol. It handles all the protocol-level
 * complexity so users only need to define their tools, resources, and prompts.
 * 
 * @module utils/mcp
 */

import type { Data, Context } from "../core/index.ts";

// ============================================================================
// MCP Protocol Types (Re-exported for convenience)
// ============================================================================

/**
 * JSON-RPC 2.0 request payload used by MCP transports.
 * See https://www.jsonrpc.org/specification#request_object
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response payload used by MCP transports.
 * See https://www.jsonrpc.org/specification#response_object
 */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 error object for responses.
 * See https://www.jsonrpc.org/specification#error_object
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Basic MCP server information reported to clients.
 */
export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * Client information received from MCP clients.
 */
export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Server capability flags for tools, resources, prompts, and logging.
 */
export interface ServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, unknown>;
}

/**
 * Describes a callable tool exposed by the MCP server.
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Parameters for invoking a tool via JSON-RPC.
 */
export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Tool response shape supporting text, images, and resources.
 */
export interface ToolResponse {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * A static resource exposed by the MCP server.
 */
export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * A URI template describing a family of resources.
 * Example: weather://{city}
 */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * The contents of a resource as returned by the server.
 */
export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * A prompt definition exposed by the MCP server.
 */
export interface Prompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * A single prompt message with role and typed content.
 */
export interface PromptMessage {
  role: "user" | "assistant";
  content: {
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  };
}

/**
 * Parameters for the MCP initialize request.
 */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: {
    roots?: {
      listChanged?: boolean;
    };
    sampling?: Record<string, unknown>;
  };
  clientInfo: ClientInfo;
}

/**
 * Result payload for MCP initialize response.
 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}

/**
 * Result payload for tools/list.
 */
export interface ListToolsResult {
  tools: Tool[];
}

/**
 * Result payload for tools/call.
 */
export interface CallToolResult {
  content: ToolResponse["content"];
  isError?: boolean;
}

/**
 * Result payload for resources/list.
 */
export interface ListResourcesResult {
  resources: Resource[];
}

/**
 * Parameters for resources/read request.
 */
export interface ReadResourceParams {
  uri: string;
}

/**
 * Result payload for resources/read.
 */
export interface ReadResourceResult {
  contents: ResourceContents[];
}

/**
 * Result payload for resources/templates/list.
 */
export interface ListResourceTemplatesResult {
  resourceTemplates: ResourceTemplate[];
}

/**
 * Result payload for prompts/list.
 */
export interface ListPromptsResult {
  prompts: Prompt[];
}

/**
 * Parameters for prompts/get request.
 */
export interface GetPromptParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Result payload for prompts/get.
 */
export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

// ============================================================================
// MCP Server Configuration
// ============================================================================

/**
 * Configuration for building an MCP server on Oxian.
 */
export interface MCPServerConfig {
  info: ServerInfo;
  capabilities: ServerCapabilities;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>>;
  readResource: (params: ReadResourceParams) => ReadResourceResult;
  getPrompt: (params: GetPromptParams) => GetPromptResult;
}

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

/**
 * Common JSON-RPC error codes used by server helpers.
 */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a JSON-RPC error payload.
 * @param code - JSON-RPC error code (use JSON_RPC_ERRORS)
 * @param message - Human-readable error message
 * @param data - Optional vendor-specific error data
 */
export function createJsonRpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return { code, message, data };
}

/**
 * Create a JSON-RPC 2.0 response payload (result or error).
 * @param id - Request id (null for parse errors)
 * @param result - Optional successful result
 * @param error - Optional error object
 */
export function createJsonRpcResponse(
  id: string | number | null,
  result?: unknown,
  error?: JsonRpcError
): JsonRpcResponse {
  // JSON-RPC 2.0 spec: id MUST be null for parse errors or when request id cannot be determined
  // The MCP SDK should handle null IDs correctly for error responses
  return {
    jsonrpc: "2.0",
    id: id,
    ...(error ? { error } : { result }),
  };
}

// ============================================================================
// URI Template Utilities
// ============================================================================

/**
 * Matches a URI against a URI template and extracts parameters
 * 
 * @param uri - The URI to match (e.g., "weather://san-francisco")
 * @param template - The URI template (e.g., "weather://{city}")
 * @returns Object with matched parameters or null if no match
 * 
 * @example
 * matchUriTemplate("weather://san-francisco", "weather://{city}")
 * // Returns: { city: "san-francisco" }
 */
function matchUriTemplate(uri: string, template: string): Record<string, string> | null {
  // Convert template to regex pattern
  // Replace {param} with capture groups
  const paramNames: string[] = [];

  // First escape special regex characters in the template
  const escapedTemplate = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Then replace escaped \{param\} with capture groups
  const regexPattern = escapedTemplate.replace(/\\{([^}]+)\\}/g, (_, paramName) => {
    paramNames.push(paramName);
    return "([^/]+)"; // Match any characters except /
  });

  const regex = new RegExp(`^${regexPattern}$`);
  const match = uri.match(regex);

  if (!match) return null;

  // Extract parameters
  const params: Record<string, string> = {};
  paramNames.forEach((name, index) => {
    params[name] = match[index + 1];
  });

  return params;
}

// ============================================================================
// MCP Protocol Handlers Factory
// ============================================================================

/**
 * Build a map of MCP method handlers from configuration.
 * @param config - MCP server configuration (tools, resources, prompts, handlers)
 * @param context - Optional Oxian context for session management
 * @returns Record of JSON-RPC method names to handler functions
 */
export function createMCPHandlers(config: MCPServerConfig, context?: Context): Record<string, (params?: unknown) => unknown | Promise<unknown>> {
  const SUPPORTED_VERSION = "2025-06-18";
  const FALLBACK_VERSION = "2024-11-05"; // For backwards compatibility

  const handlers = {
    initialize: (params: unknown): InitializeResult & { _sessionId?: string } => {
      const initParams = params as InitializeParams;

      // Protocol version negotiation
      const requestedVersion = initParams.protocolVersion;
      let negotiatedVersion = SUPPORTED_VERSION;

      if (requestedVersion !== SUPPORTED_VERSION) {
        // For backwards compatibility, support older versions
        if (requestedVersion === FALLBACK_VERSION) {
          negotiatedVersion = FALLBACK_VERSION;
          console.warn(
            `[MCP] Client using older protocol ${requestedVersion}, server prefers ${SUPPORTED_VERSION}`
          );
        } else {
          console.warn(
            `[MCP] Client requested unsupported version ${requestedVersion}, using ${SUPPORTED_VERSION}`
          );
        }
      }

      // Generate session ID for session management (optional but recommended)
      const sessionId = context ? crypto.randomUUID() : undefined;

      const result: InitializeResult & { _sessionId?: string } = {
        protocolVersion: negotiatedVersion,
        capabilities: config.capabilities,
        serverInfo: config.info,
      };

      // Internal marker for session ID (will be set as header in handleMCPRequest)
      if (sessionId) {
        result._sessionId = sessionId;
      }

      return result;
    },

    "tools/list": (): ListToolsResult => {
      return {
        tools: config.tools,
      };
    },

    "tools/call": async (params: unknown): Promise<CallToolResult> => {
      const toolParams = params as ToolCallParams;

      if (!toolParams.name) {
        throw createJsonRpcError(JSON_RPC_ERRORS.INVALID_PARAMS, "Missing tool name");
      }

      const handler = config.toolHandlers[toolParams.name];

      if (!handler) {
        throw createJsonRpcError(
          JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Tool not found: ${toolParams.name}`
        );
      }

      try {
        const result = await handler(toolParams.arguments || {});
        return result;
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `Error executing tool: ${(error as Error).message}`,
          }],
          isError: true,
        };
      }
    },

    "resources/list": (): ListResourcesResult => {
      return {
        resources: config.resources,
      };
    },

    "resources/templates/list": (): ListResourceTemplatesResult => {
      return {
        resourceTemplates: config.resourceTemplates,
      };
    },

    "resources/read": (params: unknown): ReadResourceResult => {
      const resourceParams = params as ReadResourceParams;

      if (!resourceParams.uri) {
        throw createJsonRpcError(JSON_RPC_ERRORS.INVALID_PARAMS, "Missing resource URI");
      }

      try {
        // Try reading resource directly (static resources)
        const result = config.readResource(resourceParams);
        return result;
      } catch (_error) {
        // If direct read fails, try matching against resource templates
        for (const template of config.resourceTemplates) {
          const templateParams = matchUriTemplate(resourceParams.uri, template.uriTemplate);

          if (templateParams) {
            // Found a matching template - pass both URI and extracted params
            try {
              const result = config.readResource({
                ...resourceParams,
                ...templateParams, // Merge template parameters
              } as ReadResourceParams);
              return result;
            } catch (templateError) {
              throw createJsonRpcError(
                JSON_RPC_ERRORS.INTERNAL_ERROR,
                `Error reading template resource: ${(templateError as Error).message}`
              );
            }
          }
        }

        // No template matched, throw the original error
        throw createJsonRpcError(
          JSON_RPC_ERRORS.INTERNAL_ERROR,
          `Resource not found: ${resourceParams.uri}`
        );
      }
    },

    "prompts/list": (): ListPromptsResult => {
      return {
        prompts: config.prompts,
      };
    },

    "prompts/get": (params: unknown): GetPromptResult => {
      const promptParams = params as GetPromptParams;

      if (!promptParams.name) {
        throw createJsonRpcError(JSON_RPC_ERRORS.INVALID_PARAMS, "Missing prompt name");
      }

      try {
        const result = config.getPrompt(promptParams);
        return result;
      } catch (error) {
        throw createJsonRpcError(
          JSON_RPC_ERRORS.INTERNAL_ERROR,
          `Error getting prompt: ${(error as Error).message}`
        );
      }
    },
  };

  return handlers;
}

// ============================================================================
// Main MCP Request Handler
// ============================================================================

/**
 * Session storage for MCP sessions
 * Maps session ID to protocol version
 */
const sessionStore = new Map<string, { protocolVersion: string; createdAt: number }>();

/**
 * Handle MCP JSON-RPC 2.0 POST requests (Streamable HTTP Transport)
 * 
 * Implements MCP Protocol Version 2025-06-18 Streamable HTTP transport.
 * This handler validates headers, manages sessions, routes requests,
 * and formats responses according to the latest protocol specification.
 * 
 * @param data - Request data (parsed by Oxian)
 * @param context - Oxian request context
 * @param mcpConfig - MCP server configuration (tools, resources, prompts, handlers)
 * @returns JSON-RPC response with appropriate headers
 */
export async function handleMCPRequest(
  data: Data,
  context: Context,
  mcpConfig: MCPServerConfig
): Promise<JsonRpcResponse | { acknowledged: true }> {
  const { request, response } = context;

  // ============================================================================
  // Security: Validate Origin header to prevent DNS rebinding attacks
  // ============================================================================
  const origin = request.raw.headers.get("origin");

  if (origin) {
    try {
      const originUrl = new URL(origin);
      // Allow localhost and 127.0.0.1 origins
      if (!originUrl.hostname.match(/^(localhost|127\.0\.0\.1|::1)$/)) {
        // For production, you should validate against allowed origins
        console.warn(`[MCP Security] Request from non-local origin: ${origin}`);
        // Uncomment to enforce:
        // throw createJsonRpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid origin");
      }
    } catch {
      // Invalid origin URL
    }
  }

  // ============================================================================
  // Protocol Version Header Validation (2025-06-18 spec)
  // ============================================================================
  const protocolVersionHeader = request.raw.headers.get("mcp-protocol-version");

  // Note: Protocol version is primarily negotiated during initialization
  // and stored in the session. We validate it here for informational purposes.
  if (protocolVersionHeader && protocolVersionHeader !== "2025-06-18" && protocolVersionHeader !== "2024-11-05") {
    console.warn(`[MCP] Unsupported protocol version in header: ${protocolVersionHeader}`);
  }

  // ============================================================================
  // Session Management (2025-06-18 spec)
  // ============================================================================
  const sessionId = request.raw.headers.get("mcp-session-id");

  // Validate session for non-initialization requests
  const isInitRequest = typeof data === "object" && data !== null &&
    "method" in data && data.method === "initialize";

  if (!isInitRequest && sessionId) {
    const session = sessionStore.get(sessionId);
    if (!session) {
      // Session expired or invalid - client should reinitialize
      response.status(404);
      return createJsonRpcResponse(
        null,
        undefined,
        createJsonRpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Session not found or expired. Please initialize a new session.")
      );
    }
    // Protocol version comes from session (negotiated during init)
    const _sessionProtocol = session.protocolVersion; // Reserved for future use
  }

  // ============================================================================
  // Accept Header Validation (2025-06-18 spec)
  // ============================================================================
  const acceptHeader = request.raw.headers.get("accept");
  if (acceptHeader) {
    const acceptsJson = acceptHeader.includes("application/json");
    const acceptsAll = acceptHeader.includes("*/*");

    if (!acceptsJson && !acceptsAll) {
      response.status(400);
      return createJsonRpcResponse(
        null,
        undefined,
        createJsonRpcError(
          JSON_RPC_ERRORS.INVALID_REQUEST,
          "Accept header must include 'application/json'"
        )
      );
    }
  }

  // Create handlers from config with context for session management
  const methodHandlers = createMCPHandlers(mcpConfig, context);

  // Parse JSON-RPC request
  let jsonRpcRequest: JsonRpcRequest;

  try {
    jsonRpcRequest = data as unknown as JsonRpcRequest;

    // Validate JSON-RPC format
    if (jsonRpcRequest.jsonrpc !== "2.0") {
      return createJsonRpcResponse(
        jsonRpcRequest.id ?? null,
        undefined,
        createJsonRpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC version, must be 2.0")
      );
    }

    if (!jsonRpcRequest.method) {
      return createJsonRpcResponse(
        jsonRpcRequest.id ?? null,
        undefined,
        createJsonRpcError(JSON_RPC_ERRORS.INVALID_REQUEST, "Missing method field")
      );
    }
  } catch {
    return createJsonRpcResponse(
      null,
      undefined,
      createJsonRpcError(JSON_RPC_ERRORS.PARSE_ERROR, "Invalid JSON-RPC request")
    );
  }

  // Route to appropriate handler
  const handler = methodHandlers[jsonRpcRequest.method as keyof typeof methodHandlers];

  if (!handler) {
    return createJsonRpcResponse(
      jsonRpcRequest.id ?? null,
      undefined,
      createJsonRpcError(JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${jsonRpcRequest.method}`)
    );
  }

  // Execute handler
  try {
    const result = await handler(jsonRpcRequest.params);

    // ============================================================================
    // Handle initialization response (set session ID header per 2025-06-18 spec)
    // ============================================================================
    if (jsonRpcRequest.method === "initialize" && result && typeof result === "object" && "_sessionId" in result) {
      const initResult = result as InitializeResult & { _sessionId?: string };
      const newSessionId = initResult._sessionId;

      if (newSessionId) {
        // Store session
        sessionStore.set(newSessionId, {
          protocolVersion: initResult.protocolVersion,
          createdAt: Date.now()
        });

        // Set session ID header per spec
        response.headers({
          "Mcp-Session-Id": newSessionId
        });

        // Remove internal field from response
        const cleanResult = Array.isArray(initResult)
          ? initResult
          : (({ _sessionId, ...rest }) => rest)(initResult);

        return createJsonRpcResponse(jsonRpcRequest.id ?? null, cleanResult);
      }
    }

    // ============================================================================
    // Handle notifications and responses (202 Accepted per 2025-06-18 spec)
    // ============================================================================
    if (jsonRpcRequest.id === undefined) {
      // This is a notification or response - return 202 Accepted
      response.status(202);
      return { acknowledged: true };
    }

    // ============================================================================
    // Return JSON-RPC response
    // ============================================================================
    response.headers({
      "Content-Type": "application/json"
    });

    if (Deno.env.get("MCP_DEBUG")) {
      console.log("MCP Response:", result);
    }

    return createJsonRpcResponse(jsonRpcRequest.id ?? null, result);
  } catch (err) {
    // If error is already a JsonRpcError, use it
    if (typeof err === "object" && err !== null && "code" in err) {
      return createJsonRpcResponse(jsonRpcRequest.id ?? null, undefined, err as JsonRpcError);
    }

    // Otherwise, wrap in internal error
    return createJsonRpcResponse(
      jsonRpcRequest.id ?? null,
      undefined,
      createJsonRpcError(
        JSON_RPC_ERRORS.INTERNAL_ERROR,
        (err as Error).message || "Internal server error"
      )
    );
  }
}

/**
 * Handle session deletion (DELETE method per 2025-06-18 spec)
 * 
 * Allows clients to explicitly terminate sessions.
 * 
 * @param _data - Request data (unused)
 * @param context - Oxian request context
 */
export function handleMCPSessionDelete(_data: Data, context: Context): { message?: string; error?: string } {
  const sessionId = context.request.raw.headers.get("mcp-session-id");

  if (!sessionId) {
    context.response.status(400);
    return {
      error: "Missing Mcp-Session-Id header"
    };
  }

  const deleted = sessionStore.delete(sessionId);

  if (deleted) {
    context.response.status(200);
    return {
      message: "Session terminated successfully"
    };
  } else {
    context.response.status(404);
    return {
      error: "Session not found"
    };
  }
}

// ============================================================================
// GET Handler Helper
// ============================================================================

/**
 * Handle MCP server info GET requests
 * 
 * Returns information about the MCP server, its capabilities,
 * protocol version, and usage examples.
 * 
 * @param mcpConfig - MCP server configuration
 * @returns Server information object
 */
export function handleMCPInfo(mcpConfig: MCPServerConfig): {
  protocol: string;
  protocolVersion: string;
  transport: string;
  server: ServerInfo;
  capabilities: ServerCapabilities;
  endpoints: Record<string, string>;
  headers: {
    required: Record<string, string>;
    optional: Record<string, string>;
  };
  sessionManagement: {
    enabled: boolean;
    note: string;
  };
  authentication: {
    type: string;
    note: string;
  };
  usage: {
    initialize: {
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
    request: {
      method: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    };
  };
} {
  return {
    protocol: "MCP (Model Context Protocol)",
    protocolVersion: "2025-06-18",
    transport: "Streamable HTTP",
    server: mcpConfig.info,
    capabilities: mcpConfig.capabilities,
    endpoints: {
      post: "POST /mcp - Send JSON-RPC requests",
      get: "GET /mcp - Server info (this endpoint)",
      delete: "DELETE /mcp - Terminate session (with Mcp-Session-Id header)",
    },
    headers: {
      required: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      optional: {
        "Mcp-Session-Id": "Session ID (returned from initialize)",
      },
    },
    sessionManagement: {
      enabled: true,
      note: "Session ID is returned in Mcp-Session-Id header after initialization",
    },
    authentication: {
      type: "Configured via middleware",
      note: "Check middleware.ts for auth implementation",
    },
    usage: {
      initialize: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {
              name: "example-client",
              version: "1.0.0",
            },
          },
        },
      },
      request: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "MCP-Protocol-Version": "2025-06-18",
          "Mcp-Session-Id": "session-id-from-initialize",
        },
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
      },
    },
  };
}

