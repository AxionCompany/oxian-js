# 📈 Instrumentation & Observability

Oxian embraces Deno's built-in OpenTelemetry integration for traces, metrics, and logs.

- Traces: Spans are created automatically for Deno.serve requests. Oxian adds http.route, oxian.project, and http.request_id/oxian.request_id and updates span names with the route.
- Metrics: Request duration, active requests, and body sizes are exported automatically. You can add your own counters/histograms via hooks.
- Logs: console.* output is exported as OTLP logs.

Reference: Deno OTEL docs: https://docs.deno.com/runtime/fundamentals/open_telemetry/

## Enable OTEL

```ts
export default {
  logging: {
    otel: {
      enabled: true,
      serviceName: "oxian-server",
      protocol: "http/protobuf", // or "http/json" for debugging
      resourceAttributes: { env: "local" },
      propagators: "tracecontext,baggage"
    }
  }
};
```

## Built-in OTLP Collector (Dev)

Run a minimal OTLP HTTP collector inside the hypervisor and inspect exports.

```ts
export default {
  logging: { otel: { enabled: true, serviceName: "oxian-server" } },
  runtime: {
    hv: {
      otelCollector: {
        enabled: true,
        port: 4318,
        pathPrefix: "/v1",
        onExport: async ({ kind, headers, body, contentType, project }) => {
          console.log("[otel-collector] export", { kind, project, contentType, bytes: body.byteLength });
        }
      }
    }
  }
};
```

Notes:
- Workers default the OTLP endpoint to the built-in collector when logging.otel.enabled=true and no endpoint is set.
- x-oxian-project is injected into exporter headers for project tagging.
- To inspect payloads, set logging.otel.protocol = "http/json" and decode with new TextDecoder().decode(body).

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
        onRequestStart: ({ tracer, meter, span, requestId, method, url, project }) => {
          span?.setAttribute("app.req.meta", `${project}:${method}`);
          const active = meter.createUpDownCounter("http.server.active_requests", { unit: "1" });
          active.add(1);
        },
        onRequestEnd: ({ span, meter, status, durationMs }) => {
          span?.setAttribute("app.req.duration_ms", durationMs);
          const active = meter.createUpDownCounter("http.server.active_requests", { unit: "1" });
          active.add(-1);
          const hist = meter.createHistogram("app.req.duration", { unit: "s" });
          hist.record(durationMs / 1000);
        }
      }
    }
  }
};
```

Best practices:
- Prefer units in instrument options (not in names). Use SI/UCUM like s, ms, By, 1.
- Avoid excessive cardinality in attributes.
- Keep hooks fast and non-blocking.

## Quick CLI

```bash
# Enable auto-instrumentation and point to local collector
OTEL_DENO=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 deno -A jsr:@oxian/oxian-js
```
