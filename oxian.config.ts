export default ({ root = Deno.cwd(), basePath = "/", server = { port: 8080 }, logging = { level: "info" } }) => ({
    root,
    basePath,
    loaders: {
        local: { enabled: true },
        github: { enabled: true, tokenEnv: "GITHUB_TOKEN", cacheTtlSec: 60 },
    },
    server,
    logging: { ...logging, requestIdHeader: "x-request-id" },
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
            provider: async ({ req }: { req: Request; project: string }) => {
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
                        // isolated: true,
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
});