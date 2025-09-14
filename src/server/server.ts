/**
 * @fileoverview Core HTTP server implementation for the Oxian framework.
 * 
 * This module provides the main server functionality, including request handling,
 * routing, middleware execution, dependency injection, and response processing.
 * It orchestrates the complete request lifecycle from incoming HTTP requests
 * to final responses.
 * 
 * @module server
 */

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
import { resolveRouter } from "../router/index.ts";
import { buildLocalChain, buildRemoteChain, discoverPipelineFiles } from "../runtime/pipeline_discovery.ts";
import { getLocalRootPath } from "../utils/root.ts";
import type { Resolver } from "../resolvers/types.ts";

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


/**
 * Starts the Oxian HTTP server with the provided configuration.
 * 
 * This function initializes and starts a complete HTTP server that handles routing,
 * middleware execution, dependency injection, interceptors, and request/response
 * processing. It supports both local and remote routing, CORS configuration,
 * security headers, and comprehensive logging.
 * 
 * @param opts - Configuration options for the server
 * @param opts.config - The effective Oxian configuration object
 * @param opts.source - Optional source directory or URL for routes
 * 
 * @example
 * ```typescript
 * import { startServer } from "@oxian/oxian-js/server";
 * import { loadConfig } from "@oxian/oxian-js/config";
 * 
 * const config = await loadConfig();
 * await startServer({ config });
 * ```
 */
export async function startServer(opts: { config: EffectiveConfig; source?: string }, resolver: Resolver) {

  const { config, source: _source } = opts;

  const PERF = config.logging?.performance === true;
  const _base = _source ?? config.root;
  const logger = createLogger(config.logging?.level ?? "info");

  // make logger globally available for deprecation messages
  // and obey deprecations flag
  (await import("../logging/logger.ts")).setCurrentLogger(logger, { deprecations: config.logging?.deprecations !== false });

  const perfStart = performance.now();
  const resolved = await resolveRouter({ config }, resolver);
  const perfEnd = performance.now();
  if (PERF) console.log('[perf][server] resolvedRouter', { ms: Math.round(perfEnd - perfStart) });
  const resolvedEnd = performance.now();
  if (PERF) console.log('[perf][server] resolvedRouter', { ms: Math.round(resolvedEnd - perfStart), isRemote: resolved.isRemote, routes: resolved.router?.routes?.length });

  if (PERF) console.log('[perf][server] listening', { port: config.server?.port ?? 8080 });
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

      const lazyAsync = (resolved.router as unknown as { __asyncMatch?: (p: string) => Promise<unknown> }).__asyncMatch as undefined | ((p: string) => Promise<unknown>);
      const lazyPerfStart = performance.now();
      const match = lazyAsync ? await lazyAsync(path) : resolved.router.match(path);
      const lazyPerfEnd = performance.now();
      if (PERF) console.log('[perf][server] lazyMatch', { ms: Math.round(lazyPerfEnd - lazyPerfStart) });
      const { params: queryParams, record: queryRecord } = parseQuery(url);
      // Preserve an untouched clone of the Request for consumers
      const rawClone = req.clone();
      // Capture raw body bytes without consuming the preserved clone
      let rawBody: Uint8Array | undefined = undefined;
      try {
        const bodyClone = req.clone();
        const ab = await bodyClone.arrayBuffer();
        rawBody = new Uint8Array(ab);
      } catch { /* Swallow errors reading raw body; continue with parsed body only */ }
      const body = await parseRequestBody(req);
      const pathParams = (match as unknown as { params?: Record<string, string> })?.params ?? {};
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
          rawBody,
          raw: rawClone,
        },
        dependencies: {},
        response: controller,
        oxian: { route: (match as unknown as { route?: { pattern?: string } })?.route?.pattern ?? path, startedAt },
        // pass compatibility options for handler modes
        ...(config.compatibility ? { compat: config.compatibility } as Record<string, unknown> : {}),
      };

      if (!match) {
        if (path === "/") {
          // If no match found at "/", send a basic health check response
          controller.send({ ok: true, message: "Oxian running", routes: resolved.router.routes.map((r: { pattern: string }) => r.pattern) });
          const res = finalizeResponse(state);
          logger.info("request", makeRequestLog({ requestId, route: path, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
          return res;
        }
        // If no match found at any path, send a 404 response
        return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
      }

      // Unified pipeline discovery
      let files;
      const getFilesStart = performance.now();
      if (resolved.isRemote && resolved.routesRootUrl) {
        const chain = buildRemoteChain(resolved.routesRootUrl, (match as unknown as { route: { fileUrl: URL } }).route.fileUrl);
        files = await discoverPipelineFiles(chain, resolver, { allowShared: config.compatibility?.allowShared });
      } else {
        const chain = buildLocalChain(getLocalRootPath(config.root), config.routing?.routesDir ?? "routes", (match as unknown as { route: { fileUrl: URL } }).route.fileUrl);
        files = await discoverPipelineFiles(chain, resolver, { allowShared: config.compatibility?.allowShared });
      }
      const getFilesEnd = performance.now();
      if (PERF) console.log('[perf][server] discoverPipelineFiles', { ms: Math.round(getFilesEnd - getFilesStart) });

      try {

        // Inject config-defined deps as the base
        const baseDeps = {};
        context.dependencies = baseDeps;
        // Compose route dependencies on top
        const composeStart = performance.now();
        const composed = await composeDependencies(files, {}, resolver, { allowShared: config.compatibility?.allowShared },);
        const composeEnd = performance.now();
        if (PERF) console.log('[perf][server] composeDependencies', { ms: Math.round(composeEnd - composeStart) });
        context.dependencies = { ...baseDeps, ...composed };
        {
          // Run interceptors before the route handler
          const runInterceptorsBeforeStart = performance.now();
          const result = await runInterceptorsBefore(files.interceptorFiles, data, context, resolver);
          data = result.data;
          context = result.context as Context;
          const runInterceptorsBeforeEnd = performance.now();
          if (PERF) console.log('[perf][server] runInterceptorsBefore', { ms: Math.round(runInterceptorsBeforeEnd - runInterceptorsBeforeStart) });
        }
        {
          // Run middlewares before the route handler
          const runMiddlewaresStart = performance.now();
          const result = await runMiddlewares(files.middlewareFiles, data, context, resolver, config);
          data = result.data;
          context = result.context as Context;
          const runMiddlewaresEnd = performance.now();
          if (PERF) console.log('[perf][server] runMiddlewares', { ms: Math.round(runMiddlewaresEnd - runMiddlewaresStart) });
        }
      } catch (err) {
        logger.error("pipeline_error", { requestId, err: (err as Error)?.message, stack: (err as Error)?.stack });
        const shaped = shapeError(err as unknown);
        state.status = shaped.status;
        state.body = shaped.body;
        const res = finalizeResponse(state);
        logger.info("request", makeRequestLog({ requestId, route: (match as unknown as { route?: { pattern?: string } }).route?.pattern ?? path, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
        return res;
      }

      // Load the route module
      const loadRouteModuleStart = performance.now();
      const mod = await loadRouteModule((match as unknown as { route: { fileUrl: URL } }).route.fileUrl, resolver);
      const loadRouteModuleEnd = performance.now();
      if (PERF) console.log('[perf][server] loadRouteModule', { ms: Math.round(loadRouteModuleEnd - loadRouteModuleStart) });
      const exportVal = getHandlerExport(mod, req.method);
      let resultOrError: unknown = undefined;
      if (typeof exportVal !== "function") {
        state.status = 405;
        state.body = { error: { message: "Method Not Allowed" } };
        resultOrError = new Error("Method Not Allowed");
      } else {
        const runHandlerStart = performance.now();
        const { result, error } = await runHandler(exportVal as Handler, data as Record<string, unknown>, context, state);
        resultOrError = error ?? result;
        const runHandlerEnd = performance.now();
        if (PERF) console.log('[perf][server] runHandler', { ms: Math.round(runHandlerEnd - runHandlerStart) });
      }

      // Run after interceptors
      const runInterceptorsAfterStart = performance.now();
      await runInterceptorsAfter(files.interceptorFiles, resultOrError, context, resolver);
      const runInterceptorsAfterEnd = performance.now();
      if (PERF) console.log('[perf][server] runInterceptorsAfter', { ms: Math.round(runInterceptorsAfterEnd - runInterceptorsAfterStart) });

      // Finalize the response
      const finalizeResponseStart = performance.now();
      const res = finalizeResponse(state);
      const finalizeResponseEnd = performance.now();
      if (PERF) console.log('[perf][server] finalizeResponse', { ms: Math.round(finalizeResponseEnd - finalizeResponseStart) });
      logger.info("request", makeRequestLog({ requestId, route: (match as unknown as { route: { pattern: string } }).route.pattern, method: req.method, status: state.status, durationMs: Math.round(performance.now() - startedAt), headers: req.headers, scrubHeaders: config.security?.scrubHeaders }));
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