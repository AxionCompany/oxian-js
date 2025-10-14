# 🤖 HTTP-based MCP Server (Model Context Protocol)

A complete implementation of the **MCP Protocol Version 2025-06-18 (Streamable HTTP Transport)** built using the Oxian framework. This server enables AI assistants to access tools, resources, and prompts through a standardized JSON-RPC 2.0 interface.

## 📋 What is MCP?

The Model Context Protocol (MCP) is an open protocol that enables AI assistants to securely connect to external data sources and tools. This implementation provides:

- **🔧 Tools**: Executable functions (e.g., get weather, query database)
- **📚 Resources**: Data sources and content (e.g., documentation, files)
- **📦 Resource Templates**: Dynamic resources with parameters in the URI
- **💬 Prompts**: Pre-built prompt templates with parameters

## 🏗️ Architecture

This implementation is built **from first principles** (no MCP SDK) and is now a **built-in Oxian framework feature**:

```
Client (ChatGPT,Claude, etc.)          Oxian MCP Server
      │                            │
      │  POST /mcp                 │
      │  (JSON-RPC 2.0 + Headers)  │
      ├───────────────────────────>│
      │                            │
      │                            ├─> Auth Middleware (your code)
      │                            ├─> Framework: Protocol validation
      │                            ├─> Framework: Session management
      │                            ├─> Framework: Method routing
      │                            ├─> Your code: Execute tool
      │                            │
      │  JSON-RPC Response         │
      │  + Mcp-Session-Id header   │
      │<───────────────────────────┤
```

### Components

**Framework Layer (src/utils/mcp.ts):**
- All protocol handling (JSON-RPC 2.0, session management, headers)
- Protocol version 2025-06-18 implementation
- Security validation (Origin header, protocol version)
- Export all MCP types for users

**Your Implementation:**
- **`dependencies.ts`**: Your tools, resources, and prompts
- **`middleware.ts`**: Your authentication logic (optional)
- **`index.ts`**: Simple route handler using framework utilities (~50 lines)

## 🚀 Quick Start

### 1. Set API Key (Required for Production)

```bash
export MCP_API_KEY="your-secret-api-key-here"
```

> **Note**: If `MCP_API_KEY` is not set, authentication is disabled (useful for development).

### 2. Start the Server

```bash
# Start Oxian server
deno run -A jsr:@oxian/oxian-js

# Or in dev mode with hot reload
deno run -A jsr:@oxian/oxian-js dev
```

The MCP server will be available at `http://localhost:8080/mcp`

### 3. Test with curl

**Get server info (no auth required for GET):**
```bash
curl http://localhost:8080/mcp
```

**Initialize connection (get session ID):**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }' -i
```

> **Note**: Look for `Mcp-Session-Id` header in response - you'll need it for subsequent requests!

**List available tools (with session):**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -H "Mcp-Session-Id: <session-id-from-init>" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

**Call the weather tool:**
```bash
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -H "Mcp-Session-Id: <session-id-from-init>" \
  -H "Authorization: Bearer your-secret-api-key-here" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "get_weather",
      "arguments": {
        "location": "London",
        "units": "celsius"
      }
    }
  }'
```

**Terminate session (cleanup):**
```bash
curl -X DELETE http://localhost:8080/mcp \
  -H "Mcp-Session-Id: <session-id-from-init>" \
  -H "Authorization: Bearer your-secret-api-key-here"
```

## 🆕 Protocol Version 2025-06-18 Features

This implementation supports the latest MCP protocol with:

- ✅ **Session Management** - `Mcp-Session-Id` header for stateful connections
- ✅ **Protocol Version Header** - `MCP-Protocol-Version: 2025-06-18` required
- ✅ **Accept Header** - Must include `application/json`
- ✅ **Session Termination** - DELETE endpoint to cleanly close sessions
- ✅ **Security** - Origin header validation for DNS rebinding protection
- ✅ **Backwards Compatibility** - Supports 2024-11-05 protocol

### Required Headers

**For all POST requests:**
```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer <your-api-key>
```

**After initialization:**
```http
MCP-Protocol-Version: 2025-06-18
Mcp-Session-Id: <session-id-from-server>
```

## 📡 MCP Protocol Methods

### Core Methods

| Method | Description | Parameters |
|--------|-------------|------------|
| `initialize` | Establish connection and exchange capabilities | `protocolVersion`, `capabilities`, `clientInfo` |
| `tools/list` | List all available tools | None |
| `tools/call` | Execute a tool | `name`, `arguments` |
| `resources/list` | List all available resources | None |
| `resources/read` | Read a resource | `uri` |
| `prompts/list` | List all available prompts | None |
| `prompts/get` | Get a prompt template | `name`, `arguments` |

### JSON-RPC 2.0 Format

All requests follow the JSON-RPC 2.0 specification:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "method_name",
  "params": { }
}
```

Responses:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { }
}
```

Errors:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found"
  }
}
```

## 🔧 Available Tools

### get_weather

Get current weather information for any location worldwide.

**Parameters:**
- `location` (required): City name or coordinates
- `units` (optional): "celsius" or "fahrenheit" (default: celsius)

**Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": {
      "location": "San Francisco",
      "units": "fahrenheit"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "Weather for San Francisco, United States:\n- Temperature: 65°F\n- Feels like: 63°F\n- Conditions: Partly cloudy\n- Humidity: 75%\n- Wind Speed: 12 km/h\n- Precipitation: 0 mm"
    }]
  }
}
```

## 📚 Available Resources

### weather://docs/api-info

Documentation about the weather API and its capabilities.

**Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "resources/read",
  "params": {
    "uri": "weather://docs/api-info"
  }
}
```

## 💬 Available Prompts

### weather_report

Generate a detailed weather report for a location with customizable style.

**Parameters:**
- `location` (required): Location to get weather for
- `style` (optional): "formal", "casual", or "technical"

**Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "prompts/get",
  "params": {
    "name": "weather_report",
    "arguments": {
      "location": "Tokyo",
      "style": "formal"
    }
  }
}
```

## 🔒 Authentication

The server uses simple API key-based authentication:

1. Set the `MCP_API_KEY` environment variable
2. Include the key in the `Authorization` header:
   - Format 1: `Authorization: Bearer your-api-key`
   - Format 2: `Authorization: your-api-key`

**Security Notes:**
- Use HTTPS in production
- Store API keys securely (use environment variables, never commit to code)
- Rotate keys regularly
- Consider rate limiting for production deployments

## 🛠️ Adding Your Own Tools

### 1. Define the Tool

In `dependencies.ts`:

```typescript
const myTool: Tool = {
  name: "my_custom_tool",
  description: "What your tool does",
  inputSchema: {
    type: "object",
    properties: {
      param1: { type: "string", description: "Parameter description" },
    },
    required: ["param1"],
  },
};
```

### 2. Implement the Handler

```typescript
async function callMyTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const param1 = args.param1 as string;
  
  // Your logic here
  const result = await doSomething(param1);
  
  return {
    content: [{
      type: "text",
      text: result,
    }],
  };
}
```

### 3. Register the Tool

```typescript
export default async function() {
  const tools: Tool[] = [weatherTool, myTool];
  
  const toolHandlers = {
    get_weather: callWeatherTool,
    my_custom_tool: callMyTool,
  };
  
  // ... rest of the setup
}
```

## 🧪 Testing

### Using TypeScript/Deno

```typescript
// test_mcp.ts
const response = await fetch("http://localhost:8080/mcp", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer your-api-key",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_weather",
      arguments: {
        location: "Paris",
        units: "celsius",
      },
    },
  }),
});

const data = await response.json();
console.log(data);
```

### Integration with Claude Desktop

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "oxian-weather": {
      "url": "http://localhost:8080/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer your-api-key",
        "Accept": "application/json"
      }
    }
  }
}
```

> **Note**: Claude Desktop will handle protocol version negotiation and session management automatically.

## 🔍 Error Handling

The server implements standard JSON-RPC 2.0 error codes:

| Code | Meaning |
|------|---------|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method not found |
| -32602 | Invalid params |
| -32603 | Internal error |

Example error response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32601,
    "message": "Method not found: invalid/method"
  }
}
```

## 🚀 Production Considerations

1. **HTTPS**: Use a reverse proxy (nginx, Caddy) to add TLS
2. **Rate Limiting**: Implement rate limiting middleware
3. **Logging**: Use Oxian's built-in OpenTelemetry integration
4. **Monitoring**: Track tool execution times and error rates
5. **Caching**: Consider caching weather data with TTL
6. **Scaling**: Use Oxian's hypervisor for multi-process scaling


### External Resources
- [MCP Specification 2025-06-18](https://spec.modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Specification (Latest)](https://spec.modelcontextprotocol.io/)
- [Oxian Framework Documentation](../../docs/README.md)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/specification)

## 🎯 What's Next?

This implementation demonstrates the core MCP protocol. You can extend it with:

- **More Tools**: Database queries, file operations, API integrations
- **Advanced Resources**: File system access, git repositories, databases
- **Complex Prompts**: Multi-step workflows, context-aware templates
- **Sampling**: Let the server request completions from the LLM
- **Subscriptions**: Real-time resource updates

## 📝 License

Same as Oxian framework (MIT)

