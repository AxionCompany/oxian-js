# 📈 Instrumentation & Observability

Oxian embraces Deno's built-in OpenTelemetry integration for traces, metrics,
and logs.

- Traces: Spans are created automatically for Deno.serve requests. Oxian adds
  http.route, oxian.project, and updates span names with the route.
- Metrics: Request duration, active requests, and body sizes are exported
  automatically with route/project/method/status attributes.
- Logs: console.* output is exported as OTLP logs (note: attributes are serialized
  into the log body, not as structured OTLP attributes - use span events for structured data).
- Request IDs: Oxian uses spanId as the requestId by default for automatic trace correlation.

Reference: Deno OTEL docs:
https://docs.deno.com/runtime/fundamentals/open_telemetry/

## Enable OTEL

```ts
export default {
  logging: {
    otel: {
      enabled: true,
      serviceName: "oxian-server",
      protocol: "http/protobuf", // or "http/json" for debugging
      resourceAttributes: { env: "local" },
      propagators: "tracecontext,baggage",
    },
  },
};
```

## OTLP Proxy (Recommended)

Run a minimal OTLP HTTP proxy in the hypervisor that can optionally forward to a real collector. You can decide per-request whether to forward or drop.

```ts
export default {
  logging: { otel: { enabled: true, serviceName: "oxian-server" } },
  runtime: {
    hv: {
      otelProxy: {
        enabled: true,
        port: 4318,
        pathPrefix: "/v1",
        upstream: Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT"), // e.g., http://collector:4318
        onRequest: async ({ req, kind, project, contentType }) => {
          // Safe to read; this is a clone of the original request
          if ((contentType || "").includes("json")) {
            try {
              const json = await req.json();
              console.log("[otel-proxy]", { kind, project, json: !!json });
            } catch (_) {
              const text = await req.text();
              console.log("[otel-proxy]", { kind, project, size: text.length });
            }
          }
          // drop exports for unknown projects; forward otherwise
          return ["default", "billing"].includes(project || "default");
        },
      },
    },
  },
};
```

Notes:

- Workers default the OTLP endpoint to the proxy when `logging.otel.enabled=true` and no endpoint is set.
- `x-oxian-project` is injected into exporter headers for project tagging.
- If `upstream` is not set or `onRequest` returns false, the proxy responds 202 and drops the payload (safe fail-open for exporters).

## Built-in OTLP Collector (Dev)

For local debugging, you can run a minimal built-in collector that accepts and responds 202 (no forwarding). Prefer the proxy for production scenarios.

## Logging Best Practices

Deno's OTEL auto-instrumentation captures `console.*` output as log records, but objects are **stringified into the log body** - not exported as structured OTLP attributes.

For structured, queryable data, use **span events**:

```ts
import { trace } from "npm:@opentelemetry/api@1";

export function GET(data, context) {
  const span = trace.getActiveSpan();
  
  // ❌ Bad: attributes end up in body string
  console.log("user.action", { userId: "123", action: "purchase", amount: 50 });
  
  // ✅ Good: structured attributes in trace
  span?.addEvent("user.action", { 
    "user.id": "123", 
    "action": "purchase", 
    "amount": 50 
  });
  
  return { ok: true };
}
```

Request IDs are automatically set to `spanId` for easy correlation between logs and traces.

## Custom Spans & Metrics (Hooks)

Define lifecycle hooks to add custom spans/metrics:

```ts
export default {
  logging: {
    otel: {
      enabled: true,
      hooks: {
        onInit: ({ tracer, meter }) => {
          const counter = meter.createCounter("app.init.count", { unit: "1" });
          counter.add(1);
        },
        onRequestStart: (
          { tracer, meter, span, requestId, method, url, project },
        ) => {
          span?.setAttribute("app.req.meta", `${project}:${method}`);
          const active = meter.createUpDownCounter(
            "http.server.active_requests",
            { unit: "1" },
          );
          active.add(1);
        },
        onRequestEnd: ({ span, meter, status, durationMs }) => {
          span?.setAttribute("app.req.duration_ms", durationMs);
          const active = meter.createUpDownCounter(
            "http.server.active_requests",
            { unit: "1" },
          );
          active.add(-1);
          const hist = meter.createHistogram("app.req.duration", { unit: "s" });
          hist.record(durationMs / 1000);
        },
      },
    },
  },
};
```

Best practices:

- Prefer units in instrument options (not in names). Use SI/UCUM like s, ms,
  By, 1.
- Avoid excessive cardinality in attributes.
- Keep hooks fast and non-blocking.

## Quick CLI

```bash
# Enable auto-instrumentation and point to local collector
OTEL_DENO=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 deno -A jsr:@oxian/oxian-js
```
