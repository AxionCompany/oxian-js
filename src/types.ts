/**
 * @fileoverview Public type definitions for Oxian framework.
 *
 * This module exports all public-facing types used by Oxian applications.
 * Import from here for stable, documented API types.
 *
 * @module types
 */

// Core request/response types
export type { Data } from "./core/data.ts";
export type { Context, ResponseController } from "./core/context.ts";
export type {
  Handler,
  Interceptors,
  Middleware,
  MiddlewareResult,
} from "./core/handler.ts";
export { OxianHttpError } from "./core/errors.ts";

// Configuration
export type { EffectiveConfig, OxianConfig } from "./config/schema.ts";

// Runtime (selective - only public APIs)
export type { LoadedModule, PipelineFiles } from "./runtime/types.ts";

// Router (selective - only public APIs)
export type {
  ResolvedRouter,
  RouteMatch,
  RouteParamValue,
  Router,
  RouteRecord,
  RouteSegment,
} from "./router/types.ts";

// Resolver (for advanced users)
export type { Resolver } from "./resolvers/types.ts";

// Server (selective internal types)
export type { ResponseState } from "./server/types.ts";

// Hypervisor (for advanced users)
export type { SelectedProject, WorkerHandle } from "./hypervisor/types.ts";

// MCP (Model Context Protocol) - Full protocol types
export type {
  CallToolResult,
  ClientInfo,
  GetPromptParams,
  GetPromptResult,
  // Protocol methods
  InitializeParams,
  InitializeResult,
  JsonRpcError,
  // JSON-RPC 2.0
  JsonRpcRequest,
  JsonRpcResponse,
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
  // Server configuration
  MCPServerConfig,
  // Prompts
  Prompt,
  PromptMessage,
  ReadResourceParams,
  ReadResourceResult,
  // Resources
  Resource,
  ResourceContents,
  ResourceTemplate,
  ServerCapabilities,
  // Server info
  ServerInfo,
  // Tools
  Tool,
  ToolCallParams,
  ToolResponse,
} from "./utils/mcp.ts";

// MCP helper functions and constants
export {
  createJsonRpcError,
  createJsonRpcResponse,
  createMCPHandlers,
  handleMCPInfo,
  handleMCPRequest,
  handleMCPSessionDelete,
  JSON_RPC_ERRORS,
} from "./utils/mcp.ts";
