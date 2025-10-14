# 🌊 Streaming & Server-Sent Events

Oxian provides first-class support for streaming responses and Server-Sent
Events (SSE), enabling real-time data delivery, large file processing, and live
updates without the complexity of WebSockets.

## Overview

Oxian supports three streaming approaches:

- **🌊 Response Streaming** - For large data, file downloads, or progressive
  responses
- **📡 Server-Sent Events (SSE)** - For real-time updates and live data feeds
- **🔄 Chunked Transfer** - For data of unknown length

All streaming is built on top of Web Streams API with automatic cleanup and
error handling.

## Response Streaming

### Basic Streaming

Stream text responses in chunks:

```ts
// routes/stream.ts
export async function GET(_, { response }) {
  // Start streaming with headers
  response.stream({
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
    },
  });

  // Send chunks
  response.stream("Hello ");
  await new Promise((r) => setTimeout(r, 1000));
  response.stream("streaming ");
  await new Promise((r) => setTimeout(r, 1000));
  response.stream("world!");

  // Stream automatically closes when handler returns
}
```

**Test:**

```bash
curl http://localhost:8080/stream
# Hello streaming world! (with 1s delays)
```

### JSON Streaming

Stream JSON data progressively:

```ts
// routes/data-stream.ts
export async function GET({ count = 5 }, { response }) {
  response.stream({
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  response.stream('{"items":[');

  for (let i = 1; i <= parseInt(count); i++) {
    if (i > 1) response.stream(",");

    const item = { id: i, timestamp: Date.now() };
    response.stream(JSON.stringify(item));

    // Simulate processing delay
    await new Promise((r) => setTimeout(r, 500));
  }

  response.stream("]}");
}
```

**Test:**

```bash
curl http://localhost:8080/data-stream?count=3
# {"items":[{"id":1,"timestamp":1642693800000},{"id":2,"timestamp":1642693800500},{"id":3,"timestamp":1642693801000}]}
```

### File Streaming

Stream large files efficiently:

```ts
// routes/download/[filename].ts
export async function GET({ filename }, { response }) {
  const filePath = `./uploads/${filename}`;

  try {
    const file = await Deno.open(filePath, { read: true });
    const stat = await file.stat();

    response.stream({
      headers: {
        "content-type": "application/octet-stream",
        "content-length": stat.size.toString(),
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });

    // Stream file in chunks
    const buffer = new Uint8Array(8192); // 8KB chunks
    while (true) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) break;

      response.stream(buffer.subarray(0, bytesRead));
    }

    file.close();
  } catch (error) {
    throw {
      message: "File not found",
      statusCode: 404,
    };
  }
}
```

### CSV Streaming

Generate and stream CSV data:

```ts
// routes/export/users.csv.ts
export async function GET(_, { response, dependencies }) {
  const { userService } = dependencies;

  response.stream({
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=users.csv",
    },
  });

  // CSV header
  response.stream("id,name,email,created_at\n");

  // Stream users in batches
  let page = 1;
  const pageSize = 100;

  while (true) {
    const users = await userService.findMany({
      page,
      limit: pageSize,
    });

    if (users.length === 0) break;

    for (const user of users) {
      const row =
        `${user.id},"${user.name}","${user.email}","${user.createdAt}"\n`;
      response.stream(row);
    }

    page++;
  }
}
```

## Server-Sent Events (SSE)

SSE provides one-way real-time communication from server to client, perfect for
live updates, notifications, and real-time dashboards.

### Basic SSE

```ts
// routes/events.ts
export async function GET(_, { response }) {
  const sse = response.sse({
    retry: 1000, // Client retry interval
    keepOpen: true, // Keep connection alive
  });

  let count = 0;
  const interval = setInterval(() => {
    count++;

    // Send data event
    sse.send({ count, timestamp: Date.now() }, {
      event: "counter",
      id: `msg-${count}`,
    });

    // Stop after 10 events
    if (count >= 10) {
      clearInterval(interval);
      sse.close();
    }
  }, 1000);

  // Handle client disconnect
  sse.done.then(() => {
    clearInterval(interval);
    console.log("Client disconnected");
  });
}
```

**Test with JavaScript:**

```html
<!DOCTYPE html>
<html>
  <script>
    const eventSource = new EventSource("/events");

    eventSource.addEventListener("counter", (event) => {
      const data = JSON.parse(event.data);
      console.log("Count:", data.count);
    });

    eventSource.onerror = (event) => {
      console.error("SSE error:", event);
    };
  </script>
</html>
```

### Live Chat SSE

Implement real-time chat with SSE:

```ts
// routes/chat/events.ts
const clients = new Set();

export async function GET({ room = "general" }, { response }) {
  const sse = response.sse({ retry: 3000 });

  // Add client to room
  const client = { sse, room, id: crypto.randomUUID() };
  clients.add(client);

  // Send welcome message
  sse.send({
    message: "Connected to chat",
    room,
    timestamp: Date.now(),
  }, { event: "welcome" });

  // Handle disconnect
  sse.done.then(() => {
    clients.delete(client);
    console.log(`Client ${client.id} disconnected from ${room}`);
  });
}

// Broadcast message to all clients in room
export function broadcastToRoom(room, message) {
  for (const client of clients) {
    if (client.room === room) {
      client.sse.send(message, { event: "message" });
    }
  }
}
```

```ts
// routes/chat/send.ts
import { broadcastToRoom } from "./events.ts";

export async function POST(
  { room = "general", message, username },
  { response },
) {
  if (!message || !username) {
    throw { message: "Message and username required", statusCode: 400 };
  }

  const chatMessage = {
    id: crypto.randomUUID(),
    username,
    message,
    timestamp: Date.now(),
  };

  // Broadcast to all clients in room
  broadcastToRoom(room, chatMessage);

  return { success: true, messageId: chatMessage.id };
}
```

### Real-time Dashboard

Create a live metrics dashboard:

```ts
// routes/dashboard/metrics.ts
export async function GET(_, { response, dependencies }) {
  const { metricsService } = dependencies;
  const sse = response.sse({ retry: 5000 });

  const sendMetrics = async () => {
    try {
      const metrics = await metricsService.getCurrentMetrics();
      sse.send(metrics, {
        event: "metrics",
        id: `metrics-${Date.now()}`,
      });
    } catch (error) {
      sse.send({ error: "Failed to fetch metrics" }, {
        event: "error",
      });
    }
  };

  // Send initial metrics
  await sendMetrics();

  // Send updates every 5 seconds
  const interval = setInterval(sendMetrics, 5000);

  // Cleanup on disconnect
  sse.done.then(() => {
    clearInterval(interval);
  });
}
```

### Stock Price Updates

Stream live stock prices:

```ts
// routes/stocks/[symbol]/stream.ts
export async function GET({ symbol }, { response, dependencies }) {
  const { stockService } = dependencies;
  const sse = response.sse({ retry: 10000 });

  // Validate symbol
  if (!await stockService.isValidSymbol(symbol)) {
    throw { message: "Invalid stock symbol", statusCode: 400 };
  }

  let lastPrice = null;

  const sendPriceUpdate = async () => {
    try {
      const currentPrice = await stockService.getPrice(symbol);

      if (currentPrice !== lastPrice) {
        const change = lastPrice ? currentPrice - lastPrice : 0;
        const changePercent = lastPrice ? (change / lastPrice) * 100 : 0;

        sse.send({
          symbol,
          price: currentPrice,
          change,
          changePercent,
          timestamp: Date.now(),
        }, {
          event: "price-update",
          id: `${symbol}-${Date.now()}`,
        });

        lastPrice = currentPrice;
      }
    } catch (error) {
      sse.send({
        error: `Failed to fetch price for ${symbol}`,
      }, { event: "error" });
    }
  };

  // Send initial price
  await sendPriceUpdate();

  // Update every 30 seconds
  const interval = setInterval(sendPriceUpdate, 30000);

  sse.done.then(() => {
    clearInterval(interval);
  });
}
```

## Advanced Streaming Patterns

### Conditional Streaming

Stream different content based on conditions:

```ts
// routes/feed.ts
export async function GET({ format = "json" }, { response }) {
  if (format === "csv") {
    return streamCSVFeed(response);
  } else if (format === "xml") {
    return streamXMLFeed(response);
  } else {
    return streamJSONFeed(response);
  }
}

async function streamJSONFeed(response) {
  response.stream({
    headers: { "content-type": "application/json" },
  });

  response.stream('{"feed":[');
  // ... stream JSON data
  response.stream("]}");
}

async function streamCSVFeed(response) {
  response.stream({
    headers: { "content-type": "text/csv" },
  });

  response.stream("id,title,content,timestamp\n");
  // ... stream CSV data
}
```

### Streaming with Authentication

Protect streaming endpoints:

```ts
// routes/protected/stream.ts
export async function GET(_, { response, request, dependencies }) {
  const { auth } = dependencies;

  // Verify authentication
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    throw { message: "Authentication required", statusCode: 401 };
  }

  const user = await auth.verifyToken(token);
  if (!user) {
    throw { message: "Invalid token", statusCode: 401 };
  }

  // Start authenticated stream
  const sse = response.sse();

  sse.send({
    message: `Welcome ${user.name}`,
    userId: user.id,
  }, { event: "authenticated" });

  // ... stream user-specific data
}
```

### Error Handling in Streams

Handle errors gracefully:

```ts
// routes/stream-with-errors.ts
export async function GET(_, { response }) {
  const sse = response.sse({ retry: 5000 });

  const processData = async () => {
    try {
      // Simulate data processing that might fail
      const data = await fetchExternalData();
      sse.send(data, { event: "data" });
    } catch (error) {
      console.error("Stream error:", error);

      // Send error to client
      sse.send({
        error: "Data processing failed",
        timestamp: Date.now(),
      }, { event: "error" });

      // Optionally close stream
      sse.close();
    }
  };

  const interval = setInterval(processData, 2000);

  sse.done.then(() => {
    clearInterval(interval);
  });
}
```

### Memory-efficient Large Data Streaming

Stream large datasets without loading everything into memory:

```ts
// routes/big-data.ts
export async function GET({ query }, { response, dependencies }) {
  const { database } = dependencies;

  response.stream({
    headers: { "content-type": "application/json" },
  });

  response.stream('{"results":[');

  let isFirst = true;
  const pageSize = 1000;

  // Stream data in batches
  for await (const batch of database.streamQuery(query, pageSize)) {
    for (const record of batch) {
      if (!isFirst) response.stream(",");
      response.stream(JSON.stringify(record));
      isFirst = false;
    }
  }

  response.stream("]}");
}
```

## Client-Side Integration

### JavaScript SSE Client

```javascript
class SSEClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.eventSource = null;
    this.listeners = new Map();
  }

  connect() {
    this.eventSource = new EventSource(this.url);

    this.eventSource.onopen = () => {
      console.log("SSE connected");
      this.emit("connected");
    };

    this.eventSource.onerror = (error) => {
      console.error("SSE error:", error);
      this.emit("error", error);
    };

    // Set up event listeners
    for (const [event, handler] of this.listeners) {
      this.eventSource.addEventListener(event, handler);
    }
  }

  on(event, handler) {
    this.listeners.set(event, handler);
    if (this.eventSource) {
      this.eventSource.addEventListener(event, handler);
    }
  }

  close() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  emit(event, data) {
    // Custom event handling
  }
}

// Usage
const client = new SSEClient("/events");
client.on("message", (event) => {
  const data = JSON.parse(event.data);
  console.log("Received:", data);
});
client.connect();
```

### React Hook for SSE

```tsx
import { useEffect, useState } from "react";

function useSSE(url, options = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setConnected(true);
      setError(null);
    };

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setData(data);
      } catch (err) {
        setError(err);
      }
    };

    eventSource.onerror = (err) => {
      setError(err);
      setConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [url]);

  return { data, error, connected };
}

// Usage in component
function LiveData() {
  const { data, error, connected } = useSSE("/api/live-data");

  if (error) return <div>Error: {error.message}</div>;
  if (!connected) return <div>Connecting...</div>;

  return <div>Latest data: {JSON.stringify(data)}</div>;
}
```

## Performance Considerations

### Connection Management

```ts
// Limit concurrent SSE connections
const MAX_CONNECTIONS = 1000;
const activeConnections = new Set();

export async function GET(_, { response }) {
  if (activeConnections.size >= MAX_CONNECTIONS) {
    throw {
      message: "Too many connections",
      statusCode: 503,
    };
  }

  const sse = response.sse();
  activeConnections.add(sse);

  sse.done.then(() => {
    activeConnections.delete(sse);
  });

  // ... stream logic
}
```

### Memory Management

```ts
// Clean up resources periodically
const connections = new Map();

export async function GET({ clientId }, { response }) {
  // Close existing connection for this client
  if (connections.has(clientId)) {
    connections.get(clientId).close();
  }
  
  const sse = response.sse();
  connections.set(clientId, sse);
  
  sse.done.then(() => {
    connections.delete(clientId);
  });
}

// Periodic cleanup of stale connections
setInterval(() => {
  for (const [clientId, sse] of connections) {
    if (/* connection is stale */) {
      sse.close();
      connections.delete(clientId);
    }
  }
}, 60000); // Every minute
```

## Testing Streaming

### Testing SSE Endpoints

```ts
// tests/sse.test.ts
import { assertEquals } from "https://deno.land/std@0.210.0/assert/mod.ts";

Deno.test("SSE endpoint sends events", async () => {
  const response = await fetch("http://localhost:8080/events");
  assertEquals(response.headers.get("content-type"), "text/event-stream");

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  const { value } = await reader?.read() || {};
  const chunk = decoder.decode(value);

  assert(chunk.includes("data:"));
});
```

### Manual Testing

```bash
# Test streaming endpoint
curl -N http://localhost:8080/stream

# Test SSE endpoint
curl -N -H "Accept: text/event-stream" http://localhost:8080/events
```

## Best Practices

### ✅ Do

- Set appropriate headers for streaming content
- Handle client disconnections gracefully
- Implement proper error handling in streams
- Use backpressure for large data streams
- Clean up resources (timers, connections) on disconnect
- Consider connection limits for SSE endpoints
- Test streaming endpoints thoroughly

### ❌ Don't

- Don't buffer entire datasets in memory before streaming
- Don't forget to handle client disconnections
- Don't ignore streaming errors
- Don't create memory leaks with uncleaned resources
- Don't stream sensitive data without authentication
- Don't forget appropriate cache headers

---

Streaming and SSE in Oxian enable powerful real-time applications. Start with
simple use cases and gradually build more sophisticated streaming patterns as
your application needs grow.

**Next Steps:**

- [Error Handling](./error-handling.md) - Handle streaming errors
- [Middleware](./middleware.md) - Add authentication to streams
- [Performance Guide](./performance.md) - Optimize streaming performance
