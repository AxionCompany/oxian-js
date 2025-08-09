import { EffectiveConfig } from "../config/types.ts";
import { createLogger, makeRequestLog } from "../logging/logger.ts";
import { createResponseController, finalizeResponse } from "../utils/response.ts";
import { parseQuery, parseRequestBody, mergeData } from "../utils/request.ts";
import type { Context, Data, Handler } from "../core/types.ts";
import { loadRouteModule, getHandlerExport } from "../runtime/module_loader.ts";
import { runHandler, shapeError } from "../runtime/pipeline.ts";
import { composeDependencies } from "../runtime/dependencies.ts";
import { runInterceptorsBefore, runInterceptorsAfter } from "../runtime/interceptors.ts";
import { runMiddlewares } from "../runtime/middlewares.ts";
import { resolveRouter } from "../runtime/router_resolver.ts";
import { buildLocalChain, buildRemoteChain, discoverPipelineFilesGeneric } from "../runtime/pipeline_discovery.ts";

function applyTrailingSlash(path: string, mode: "always" | "never" | "preserve" | undefined): string {
  if (mode === "preserve" || !mode) return path;
  if (mode === "always") return path.endsWith("/") ? path : path + "/";
  if (mode === "never") return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return path;
}

function applyCorsAndDefaults(headers: Headers, config: EffectiveConfig) {
  const cors = config.security?.cors;
  if (cors) {
    if (cors.allowedOrigins?.length) headers.set("access-control-allow-origin", cors.allowedOrigins.join(","));
    if (cors.allowedHeaders?.length) headers.set("access-control-allow-headers", cors.allowedHeaders.join(","));
    if (cors.methods?.length) headers.set("access-control-allow-methods", cors.methods.join(","));
  }
  const defaults = config.security?.defaultHeaders;
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) headers.set(k.toLowerCase(), v);
  }
}

export async function startServer(opts: { config: EffectiveConfig; source?: string }) {
  const { config, source } = opts;
  const logger = createLogger(config.logging?.level ?? "info");
  const resolved = await resolveRouter(config, source);

  const server = Deno.serve({ port: config.server?.port ?? 8080 }, async (req) => {
    const startedAt = performance.now();
    const hdrRequestId = config.logging?.requestIdHeader ? req.headers.get(config.logging.requestIdHeader) : undefined;
    const requestId = hdrRequestId || crypto.randomUUID();

    try {
      const url = new URL(req.url);
      const basePath = config.basePath ?? "/";
      let path = url.pathname;
      if (basePath && basePath !== "/") {
        if (!path.startsWith(basePath)) {
          return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
        }
        path = path.slice(basePath.length) || "/";
      }

      path = applyTrailingSlash(path, config.routing?.trailingSlash);

      const lazyAsync = (resolved.router as any).__asyncMatch as undefined | ((p: string) => Promise<any>);
      const match = lazyAsync ? await lazyAsync(path) : resolved.router.match(path);

      const { params: queryParams, record: queryRecord } = parseQuery(url);
      const body = await parseRequestBody(req);
      const pathParams = (match as any)?.params ?? {};
      let data: Data = mergeData(pathParams, queryRecord, body);

      const { controller, state } = createResponseController();
      applyCorsAndDefaults(state.headers, config);

      let context: Context = {
        requestId,
        request: {
          method: req.method,
          url: req.url,
          headers: req.headers,
          pathParams,
          queryParams,
          query: queryRecord,
          body,
          raw: req,
        },
        dependencies: {},
        response: controller,
        oxian: { route: (match as any)?.route?.pattern ?? path, startedAt },
      };

      if (!match) {
        if (path === "/") {
          controller.send({ ok: true, message: "Oxian running", routes: resolved.router.routes.map((r: any) => r.pattern) });
          const res = finalizeResponse(state);
          logger.info("request", makeRequestLog({ requestId, route: path, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
          return res;
        }
        return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      }

      // Unified pipeline discovery
      let files;
      if (resolved.isRemote && resolved.routesRootUrl) {
        const chain = buildRemoteChain(resolved.routesRootUrl, (match as any).route.fileUrl);
        files = await discoverPipelineFilesGeneric(chain, async (urlOrPath) => {
          if (typeof urlOrPath === "string") return false;
          const st = await resolved.loaderManager.getActiveLoader(resolved.routesRootUrl!).stat?.(urlOrPath);
          return !!st?.isFile;
        });
      } else {
        const chain = buildLocalChain(config.root ?? Deno.cwd(), config.routing?.routesDir ?? "routes", (match as any).route.fileUrl);
        files = await discoverPipelineFilesGeneric(chain, async (urlOrPath) => {
          if (typeof urlOrPath !== "string") return false;
          try {
            const st = await Deno.stat(urlOrPath);
            return st.isFile;
          } catch { return false; }
        });
      }

      try {
        const loaders = resolved.loaderManager.getLoaders();
        context.dependencies = await composeDependencies(files, {}, loaders);
        {
          const result = await runInterceptorsBefore(files.interceptorFiles, data, context, loaders);
          data = result.data;
          context = result.context as Context;
        }
        {
          const result = await runMiddlewares(files.middlewareFiles, data, context, loaders);
          data = result.data;
          context = result.context as Context;
        }
      } catch (err) {
        logger.error("pipeline_error", { requestId, err: (err as Error)?.message, stack: (err as Error)?.stack });
        const shaped = shapeError(err);
        state.status = shaped.status;
        state.body = shaped.body;
        const res = finalizeResponse(state);
        logger.info("request", makeRequestLog({ requestId, route: (match as any).route?.pattern ?? path, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
        return res;
      }

      const mod = await loadRouteModule((match as any).route.fileUrl);
      const exportVal = getHandlerExport(mod, req.method);
      let resultOrError: unknown = undefined;
      if (typeof exportVal !== "function") {
        state.status = 405;
        state.body = { error: { message: "Method Not Allowed" } };
        resultOrError = new Error("Method Not Allowed");
      } else {
        const { result, error } = await runHandler(exportVal as Handler, data as Record<string, unknown>, context, state);
        resultOrError = error ?? result;
      }

      await runInterceptorsAfter(files.interceptorFiles, resultOrError, context, resolved.loaderManager.getLoaders());

      const res = finalizeResponse(state);
      logger.info("request", makeRequestLog({ requestId, route: (match as any).route.pattern, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
      return res;
    } catch (err) {
      const requestIdForErr = crypto.randomUUID();
      logger.error("unhandled", { requestId: requestIdForErr, err: (err as Error).message });
      return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  });

  logger.info("listening", { port: config.server?.port ?? 8080 });
  await server.finished;
} 