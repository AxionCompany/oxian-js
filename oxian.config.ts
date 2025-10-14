export default ({ root = Deno.cwd(), basePath = "/", server = { port: 8080 }, logging = { level: "info" } }) => ({
    root,
    basePath:"/",
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
            // When omitted, workers will default to the built-in collector below
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
            // Minimal built-in OTLP HTTP collector; workers default to this when no endpoint provided above
            otelCollector: {
                enabled: true,
                port: 4318,
                pathPrefix: "/v1",
                onExport: async ({ kind, headers: _headers, body, contentType, project }: { kind: string; headers: Record<string, string>; body: Uint8Array; contentType: string; project?: string }) => {
                    if ((contentType || "").includes("json")) {
                        const text = new TextDecoder().decode(body);
                        const json = JSON.stringify(JSON.parse(text));
                        console.log("[otel-collector] export json", json);
                    } else {
                        console.log("[otel-collector] export binary", { kind, project, contentType, bytes: body.byteLength });
                    }
                },
            },
            // Example: modify requests before passing to workers
            onRequest: ({ req, project }: { req: Request; project: string }) => {
                // Example: add a custom header to all requests
                const headers = new Headers(req.headers);
                headers.set("x-custom-header", `processed-by-hypervisor-for-${project}`);
                return new Request(req, { headers });
            },
            provider: async ({ req }: { req: Request }) => {
                if (req) {
                    const host = new URL(req.url).hostname;
                    if (host === "localhost") return {
                        project: "local",
                        env: { CUSTOM: "1" },
                    };
                    if (host === "0.0.0.0") return {
                        project: "github",
                        source: "github:AxionCompany/oxian-js?ref=main",
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
