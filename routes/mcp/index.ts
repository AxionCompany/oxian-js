/**
 * MCP HTTP Server - Main Endpoint
 * 
 * Implements MCP Protocol Version 2025-06-18 Streamable HTTP transport.
 * This is a simple example showing how to use Oxian's MCP utilities.
 * All protocol handling is done by the framework - you just need to
 * provide your tools, resources, and prompts in dependencies.ts
 */

import type { Data, Context } from "@oxian/oxian-js/types";
import type { MCPServerConfig } from "@oxian/oxian-js/mcp";
import { 
  handleMCPRequest, 
  handleMCPInfo,
  handleMCPSessionDelete 
} from "@oxian/oxian-js/mcp";

/**
 * POST handler - Processes JSON-RPC 2.0 MCP requests
 * 
 * Extracts MCP configuration from dependencies and passes it to the handler.
 * The handler processes all protocol complexity per 2025-06-18 spec:
 * - Protocol version header validation
 * - Session management (Mcp-Session-Id header)
 * - JSON-RPC parsing and validation
 * - Method routing
 * - Error handling
 * - Response formatting
 */
export async function POST(data: Data, context: Context) {
  try {
    // Extract MCP config from dependencies (defined in dependencies.ts)
    const mcpConfig = (context.dependencies as { mcpServer: MCPServerConfig }).mcpServer;
    
    return await handleMCPRequest(data, context, mcpConfig);
  } catch (error) {
    console.error("Error handling MCP request", error);
    return {
      error: "Internal server error"
    };
  }
}

/**
 * GET handler - Returns server information
 * 
 * Provides metadata about the MCP server including:
 * - Protocol version and transport type
 * - Server capabilities
 * - Available endpoints
 * - Usage examples
 */
export function GET(_data: Data, context: Context) {
  try {
    // Extract MCP config from dependencies and return server info
    const mcpConfig = (context.dependencies as { mcpServer: MCPServerConfig }).mcpServer;
    return handleMCPInfo(mcpConfig);
  } catch (error) {
    console.error("Error in GET handler:", error);
    return {
      error: "Internal server error",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * DELETE handler - Terminate MCP session
 * 
 * Per MCP spec 2025-06-18, allows clients to explicitly terminate sessions.
 * Requires Mcp-Session-Id header.
 */
export function DELETE(data: Data, context: Context) {
  return handleMCPSessionDelete(data, context);
}
