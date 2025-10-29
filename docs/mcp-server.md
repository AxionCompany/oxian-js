# 🤖 MCP Server - Framework Feature

Oxian includes built-in support for creating **MCP (Model Context Protocol) servers** using **streamable HTTP transport**. All the protocol complexity is handled by the framework - you just define your tools, resources, and prompts!

## 📡 Streamable HTTP Transport

This implementation uses **streamable HTTP** as defined in the MCP specification:
- **POST** for client-to-server requests (JSON-RPC 2.0)
- **GET** for server metadata and capabilities
- **DELETE** for session termination
- Full support for the 2025-06-18 protocol version

## 🎯 Quick Start

### 1. Create Dependencies (Your Logic)

Create `routes/mcp/dependencies.ts`:

```typescript
import type {
  Tool,
  CallToolResult,
  MCPServerConfig,
} from "@oxian/oxian-js/mcp";

// Define your tool
const myTool: Tool = {
  name: "get_data",
  description: "Get some data",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" }
    },
    required: ["query"]
  }
};

// Implement your tool
async function callMyTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  const result = await fetchData(query);
  
  return {
    content: [{
      type: "text",
      text: result
    }]
  };
}

// Export configuration
export default function() {
  const mcpServer: MCPServerConfig = {
    info: {
      name: "my-mcp-server",
      version: "1.0.0"
    },
    capabilities: {
      tools: {}
    },
    tools: [myTool],
    resources: [],
    prompts: [],
    toolHandlers: {
      get_data: callMyTool
    },
    readResource: () => ({ contents: [] }),
    getPrompt: () => ({ messages: [] })
  };

  return { mcpServer };
}
```

### 2. Create Route Handler (Framework Does the Work)

Create `routes/mcp/index.ts`:

```typescript
import type { Data, Context } from "@oxian/oxian-js/types";
import { handleMCPRequest, handleMCPInfo } from "@oxian/oxian-js/mcp";

export async function POST(data: Data, context: Context) {
  const mcpConfig = context.dependencies.mcpServer;
  return await handleMCPRequest(data, context, mcpConfig);
}

export function GET(_data: Data, context: Context) {
  const mcpConfig = context.dependencies.mcpServer;
  return handleMCPInfo(mcpConfig);
}
```

**That's it!** The framework handles:
- ✅ JSON-RPC 2.0 parsing
- ✅ Method routing
- ✅ Error handling
- ✅ Response formatting

### 3. Optional: Add Authentication

Create `routes/mcp/middleware.ts`:

```typescript
import type { Data, Context } from "@oxian/oxian-js/types";

export default function(_data: Data, context: Context) {
  const apiKey = Deno.env.get("MCP_API_KEY");
  const provided = context.request.headers.get("authorization");
  
  if (apiKey && provided !== `Bearer ${apiKey}`) {
    throw { statusCode: 401, message: "Unauthorized" };
  }
  
  return {};
}
```

### 4. Run Your Server

```bash
export MCP_API_KEY="your-key"
deno run -A jsr:@oxian/oxian-js dev
```

## 📚 Available Types

Import all MCP types from the framework:

```typescript
import type {
  // Core types
  MCPServerConfig,
  Tool,
  Resource,
  Prompt,
  
  // Request/Response types
  CallToolResult,
  ReadResourceParams,
  ReadResourceResult,
  GetPromptParams,
  GetPromptResult,
  
  // JSON-RPC types
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  
  // Server types
  ServerInfo,
  ServerCapabilities,
  ClientInfo,
} from "@oxian/oxian-js/mcp";
```

## 🔧 Framework Utilities

### `handleMCPRequest(data, context, mcpConfig)`

Main POST handler that processes JSON-RPC 2.0 requests over streamable HTTP:

```typescript
export async function POST(data: Data, context: Context) {
  const mcpConfig = context.dependencies.mcpServer;
  return await handleMCPRequest(data, context, mcpConfig);
}
```

**What it does:**
1. Parses and validates JSON-RPC request
2. Routes to appropriate MCP method
3. Executes handler from your dependencies
4. Formats and returns response

### `handleMCPInfo(mcpConfig)`

GET handler that returns server information:

```typescript
export function GET(_data: Data, context: Context) {
  const mcpConfig = context.dependencies.mcpServer;
  return handleMCPInfo(mcpConfig);
}
```

**Returns:**
- Server info and capabilities
- Protocol version
- Usage examples

### `createMCPHandlers(config)`

Internal function that creates method handlers from your config. You don't need to call this directly - `handleMCPRequest` uses it internally.

## 🏗️ Architecture

```
Your Route Handler (index.ts)
    ↓
Framework Utilities (src/utils/mcp.ts)
    ├── JSON-RPC Parser
    ├── Method Router
    ├── Error Handler
    └── Response Formatter
    ↓
Your Dependencies (dependencies.ts)
    ├── Tool Definitions
    ├── Tool Handlers
    ├── Resource Handlers
    └── Prompt Handlers
```

## 📝 Complete Example

See the reference implementation in `routes/mcp/`:
- `dependencies.ts` - Example with weather tool
- `index.ts` - Simple handler using framework utilities
- `middleware.ts` - API key authentication

## 🔍 What You Control

| Aspect | Where | Description |
|--------|-------|-------------|
| **Tools** | `dependencies.ts` | Define and implement your tools |
| **Resources** | `dependencies.ts` | Define and read resources |
| **Prompts** | `dependencies.ts` | Define and generate prompts |
| **Auth** | `middleware.ts` | Authentication logic |
| **Server Info** | `dependencies.ts` | Server name, version |

## 🚫 What the Framework Handles

- ✅ JSON-RPC 2.0 protocol
- ✅ Request parsing and validation
- ✅ Method routing
- ✅ Error codes and formatting
- ✅ Response structure
- ✅ Protocol compliance

## 💡 Best Practices

### 1. Type Everything
```typescript
import type { Tool, CallToolResult } from "@oxian/oxian-js/mcp";

const myTool: Tool = { /* ... */ };

async function callMyTool(args: Record<string, unknown>): Promise<CallToolResult> {
  // TypeScript will help you get the structure right
}
```

### 2. Use MCPServerConfig Type
```typescript
import type { MCPServerConfig } from "@oxian/oxian-js/mcp";

const mcpServer: MCPServerConfig = {
  // TypeScript ensures you include all required fields
};
```

### 3. Handle Errors Gracefully
```typescript
async function callTool(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const result = await dangerousOperation(args);
    return {
      content: [{ type: "text", text: result }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error: ${error.message}`
      }],
      isError: true
    };
  }
}
```

### 4. Validate Input
```typescript
async function callTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  
  if (!query || query.length === 0) {
    return {
      content: [{ type: "text", text: "Query parameter required" }],
      isError: true
    };
  }
  
  // Continue with valid input
}
```

## 🎯 Supported MCP Methods

The framework automatically handles these methods:

| Method | Description | Handler in Dependencies |
|--------|-------------|------------------------|
| `initialize` | Handshake | Uses `info` and `capabilities` |
| `tools/list` | List tools | Returns `tools` array |
| `tools/call` | Execute tool | Calls `toolHandlers[name]` |
| `resources/list` | List resources | Returns `resources` array |
| `resources/read` | Read resource | Calls `readResource` function |
| `prompts/list` | List prompts | Returns `prompts` array |
| `prompts/get` | Get prompt | Calls `getPrompt` function |

## 🔗 Related Documentation

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Example Implementation](../routes/mcp/)
- [Dependency Injection](./dependency-injection.md)
- [Middleware](./middleware.md)

---

**The framework makes MCP simple!** Just define your tools and let Oxian handle the protocol. 🚀

