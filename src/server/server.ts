import type { EffectiveConfig } from "../config/types.ts";
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
import { buildLocalChain, buildRemoteChain, discoverPipelineFiles} from "../runtime/pipeline_discovery.ts";
import { createLoaderManager } from "../loader/index.ts";
import { importModule } from "../runtime/importer.ts";
import { getLocalRootPath } from "../utils/root.ts";

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

async function loadBootstrapDeps(config: EffectiveConfig): Promise<Record<string, unknown>> {
  const runtimeDeps = config.runtime?.dependencies;
  let deps: Record<string, unknown> = { ...(runtimeDeps?.initial ?? {}) };
  if (runtimeDeps?.bootstrapModule) {
    const lm = createLoaderManager(config.root ?? Deno.cwd());
    const url = lm.resolveUrl(runtimeDeps.bootstrapModule);
    const mod = await importModule(url, lm.getLoaders(), 60_000, getLocalRootPath(config.root));
    const factory = (mod as any).default ?? (mod as any).createDependencies;
    if (typeof factory === "function") {
      const produced = await factory(config);
      if (produced && typeof produced === "object") deps = { ...deps, ...(produced as Record<string, unknown>) };
    } else if (mod && typeof mod === "object") {
      deps = { ...deps, ...(mod as Record<string, unknown>) };
    }
  }
  // Freeze readonly keys
  if (runtimeDeps?.readonly?.length) {
    for (const key of runtimeDeps.readonly) {
      if (key in deps) {
        try { Object.freeze((deps as any)[key]); } catch {}
      }
    }
  }
  return deps;
}

export async function startServer(opts: { config: EffectiveConfig; source?: string }) {
  const { config, source } = opts;
  const logger = createLogger(config.logging?.level ?? "info");

  // make logger globally available for deprecation messages
  // and obey deprecations flag
  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
  (await import("../logging/logger.ts")).setCurrentLogger(logger, { deprecations: config.logging?.deprecations !== false });
  const resolved = await resolveRouter(config, source);
  console.log('[server] resolved router', { isRemote: resolved.isRemote, routes: resolved.router?.routes?.length });

  // Preload config-defined dependencies (worker-lifecycle)
  const hvInitialDeps = await loadBootstrapDeps(config);

  console.log('[server] listening', { port: config.server?.port ?? 8080 });
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

      // Lightweight health endpoint to avoid triggering route pipeline during readiness probes
      if (req.method === "HEAD" && path === "/_health") {
        const res = new Response(null, { status: 200 });
        logger.info("request", makeRequestLog({ requestId, route: path, method: req.method, status: 200, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
        return res;
      }

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
        // pass compatibility options for handler modes
        ...(config.compatibility ? { compat: config.compatibility } as any : {}),
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
        files = await discoverPipelineFiles(chain, async (urlOrPath) => {
          if (typeof urlOrPath === "string") return false;
          const st = await resolved.loaderManager.getActiveLoader(resolved.routesRootUrl!).stat?.(urlOrPath);
          return !!st?.isFile;
        });
      } else {
        const chain = buildLocalChain(getLocalRootPath(config.root), config.routing?.routesDir ?? "routes", (match as any).route.fileUrl);
        files = await discoverPipelineFiles(chain, async (urlOrPath) => {
          if (typeof urlOrPath !== "string") return false;
          try {
            const st = await Deno.stat(urlOrPath);
            return st.isFile;
          } catch { return false; }
        });
      }

      try {
        const loaders = resolved.loaderManager.getLoaders();
        // Inject config-defined deps as the base
        const baseDeps = { ...hvInitialDeps };
        context.dependencies = baseDeps;
        // Compose route dependencies on top
        const composed = await composeDependencies(files, {}, loaders, { allowShared: config.compatibility?.allowShared });
        context.dependencies = { ...baseDeps, ...composed };
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