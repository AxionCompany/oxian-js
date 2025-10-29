/**
 * @fileoverview Public type definitions for Oxian framework.
 * 
 * This module exports all public-facing types used by Oxian applications.
 * Import from here for stable, documented API types.
 * 
 * @module types
 */

// Core request/response types
export type { Data } from './core/data.ts';
export type { Context, ResponseController } from './core/context.ts';
export type { 
  Handler, 
  Middleware, 
  MiddlewareResult, 
  Interceptors 
} from './core/handler.ts';
export { OxianHttpError } from './core/errors.ts';

// Configuration
export type { OxianConfig, EffectiveConfig } from './config/schema.ts';

// Runtime (selective - only public APIs)
export type { LoadedModule, PipelineFiles } from './runtime/types.ts';

// Router (selective - only public APIs)
export type { RouteRecord, RouteMatch, Router, ResolvedRouter } from './router/types.ts';

// Resolver (for advanced users)
export type { Resolver } from './resolvers/types.ts';

// Server (selective internal types)
export type { ResponseState } from './server/types.ts';

// Hypervisor (for advanced users)
export type { SelectedProject, WorkerHandle } from './hypervisor/types.ts';

// MCP (Model Context Protocol) - Full protocol types
export type {
  // JSON-RPC 2.0
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  // Server info
  ServerInfo,
  ClientInfo,
  ServerCapabilities,
  // Tools
  Tool,
  ToolCallParams,
  ToolResponse,
  // Resources
  Resource,
  ResourceTemplate,
  ResourceContents,
  // Prompts
  Prompt,
  PromptMessage,
  // Protocol methods
  InitializeParams,
  InitializeResult,
  ListToolsResult,
  CallToolResult,
  ListResourcesResult,
  ReadResourceParams,
  ReadResourceResult,
  ListResourceTemplatesResult,
  ListPromptsResult,
  GetPromptParams,
  GetPromptResult,
  // Server configuration
  MCPServerConfig,
} from './utils/mcp.ts';

// MCP helper functions and constants
export {
  JSON_RPC_ERRORS,
  createJsonRpcError,
  createJsonRpcResponse,
  createMCPHandlers,
  handleMCPRequest,
  handleMCPSessionDelete,
  handleMCPInfo,
} from './utils/mcp.ts';
