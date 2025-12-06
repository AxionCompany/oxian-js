export default ({ root = Deno.cwd(), basePath: _basePath = "/", server = { port: 8080 }, logging = { level: "info" } }) => ({
    root,
    basePath: "/",
    loaders: {
        local: { enabled: true },
        github: { enabled: true, tokenEnv: "GITHUB_TOKEN", cacheTtlSec: 60 },
    },
    server,
    logging: {
        ...logging,
        requestIdHeader: "x-request-id",
        // Enable Deno OTEL auto-instrumentation and configure exporter/resource
        otel: {
            enabled: false,
            serviceName: "oxian-server",
            // When omitted, workers will default to the built-in OTLP proxy below
            // endpoint: "http://localhost:4318",
            protocol: "http/json",
            propagators: "tracecontext,baggage",
            resourceAttributes: { env: "local" },
            metricExportIntervalMs: 60000,
        },
    },
    routing: { routesDir: "routes", trailingSlash: "preserve", discovery: "eager" },
    security: {
        cors: {
            allowedOrigins: ["*"],
            allowedHeaders: ["authorization", "content-type"],
            methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        },
        defaultHeaders: { "x-powered-by": "oxian" },
        scrubHeaders: ["authorization", "cookie", "set-cookie"],
    },
    runtime: {
        // hotReload: true,
        dependencies: {
            initial: { feature: "on" },
            merge: "shallow",
        },
        hv: {
            // Minimal built-in OTLP HTTP proxy; workers default to this when no endpoint provided above
            otelProxy: {
                enabled: true,
                port: 4318,
                pathPrefix: "/v1",
                // Forward to external collector when provided; otherwise, proxy will accept and drop (202)
                // upstream: Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT") || "",
                // Return true to forward, false to drop. Example: allowlist by project
                onRequest: async (input: { req: Request; kind?: string }) => {
                    if (input.kind === "traces") {
                        console.log("[otel-proxy] onReques Metrics", await input?.req?.text());
                    } else if (input.kind === "logs") {
                        console.log("[otel-proxy] onRequest Logs", await input?.req?.text());
                    }
                    return false;
                },
            },
            // Example: modify requests before passing to workers
            onRequest: ({ req, project }: { req: Request; project: string }) => {
                // Example: add a custom header to all requests
                const headers = new Headers(req.headers);
                headers.set("x-custom-header", `processed-by-hypervisor-for-${project}`);
                return new Request(req, { headers });
            },
            provider: ({ req }: { req: Request }) => {
                if (req) {
                    const host = new URL(req.url).hostname;
                    if (host === "localhost") return {
                        project: "local",
                        env: { CUSTOM: "1" },
                    };
                    if (host === "0.0.0.0") return {
                        project: "github",
                        source: "github:copilotzhq/jaze-test?ref=main",
                        env: { CUSTOM: "1" },
                        githubToken: Deno.env.get("GITHUB_TOKEN") || undefined,
                        isolated: true,
                        // materialize: true
                    };
                    return { project: "local" };
                }
                return { project: "local" } as unknown as { project: string };
            },
        },
    },
    compatibility: {
        middlewareMode: "this",
        useMiddlewareRequest: true,
    },
    // prepare: ['touch test.txt'],
});
