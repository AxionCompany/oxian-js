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
// previous custom logger removed; use OTEL and minimal console
import { trace, metrics, context } from "npm:@opentelemetry/api@1";

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
import type { Resolver } from "../resolvers/types.ts";

/**
 * Patches console methods to automatically inject request_id into log attributes.
 * This allows using regular console.log() while ensuring OTEL collectors can read request_id.
 * Returns a cleanup function to restore original console methods.
 */
function patchConsoleForRequest(requestId: string): () => void {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalDebug = console.debug;

  // Patch console methods to inject request_id attributes
  console.log = (message?: unknown, ...optionalParams: unknown[]) => {
    const firstParam = optionalParams[0];
    if (firstParam && typeof firstParam === 'object' && !Array.isArray(firstParam)) {
      // If first param is an object, merge request_id into it
      originalLog(message, {
        "oxian.request_id": requestId,
        ...firstParam as Record<string, unknown>,
      }, ...optionalParams.slice(1));
    } else {
      // Otherwise, add request_id as second parameter
      originalLog(message, {
        "oxian.request_id": requestId,
      }, ...optionalParams);
    }
  };

  console.error = (message?: unknown, ...optionalParams: unknown[]) => {
    const firstParam = optionalParams[0];
    if (firstParam && typeof firstParam === 'object' && !Array.isArray(firstParam)) {
      originalError(message, {
        "oxian.request_id": requestId,
        ...firstParam as Record<string, unknown>,
      }, ...optionalParams.slice(1));
    } else {
      originalError(message, {
        "oxian.request_id": requestId,
      }, ...optionalParams);
    }
  };

  console.warn = (message?: unknown, ...optionalParams: unknown[]) => {
    const firstParam = optionalParams[0];
    if (firstParam && typeof firstParam === 'object' && !Array.isArray(firstParam)) {
      originalWarn(message, {
        "oxian.request_id": requestId,
        ...firstParam as Record<string, unknown>,
      }, ...optionalParams.slice(1));
    } else {
      originalWarn(message, {
        "oxian.request_id": requestId,
      }, ...optionalParams);
    }
  };

  console.debug = (message?: unknown, ...optionalParams: unknown[]) => {
    const firstParam = optionalParams[0];
    if (firstParam && typeof firstParam === 'object' && !Array.isArray(firstParam)) {
      originalDebug(message, {
        "oxian.request_id": requestId,
        ...firstParam as Record<string, unknown>,
      }, ...optionalParams.slice(1));
    } else {
      originalDebug(message, {
        "oxian.request_id": requestId,
      }, ...optionalParams);
    }
  };

  // Return cleanup function to restore original console
  return () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    console.debug = originalDebug;
  };
}

// Minimal MIME type mapping for static serving
const mimeByExt: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  cjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  ico: "image/x-icon",
  webp: "image/webp",
  wasm: "application/wasm",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};
function guessContentType(filePath: string): string | undefined {
  const idx = filePath.lastIndexOf(".");
  if (idx < 0) return undefined;
  const ext = filePath.slice(idx + 1).toLowerCase();
  return mimeByExt[ext];
}
function applyTrailingSlash(path: string, mode: "always" | "never" | "preserve" | undefined): string {
  if (mode === "preserve" || !mode) return path;
  if (mode === "always") return path.endsWith("/") ? path : path + "/";
  if (mode === "never") return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return path;
}

function applyCorsAndDefaults(headers: Headers, config: EffectiveConfig, req?: Request) {
  const cors = config.security?.cors;
  if (cors) {
    const requestOrigin = req?.headers.get("origin") ?? "";
    const allowedOrigins = cors.allowedOrigins ?? [];

    // Determine Access-Control-Allow-Origin
    let originToSet: string | undefined;
    if (allowedOrigins.includes("*")) {
      if (cors.allowCredentials && requestOrigin) {
        originToSet = requestOrigin;
        headers.append("vary", "Origin");
      } else {
        originToSet = "*";
      }
    } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      originToSet = requestOrigin;
      headers.append("vary", "Origin");
    }
    if (originToSet) headers.set("access-control-allow-origin", originToSet);

    // Methods
    const methods = cors.methods?.length ? cors.methods : ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
    headers.set("access-control-allow-methods", methods.join(","));

    // Allowed headers (echo request if not configured)
    if (cors.allowedHeaders?.length) {
      headers.set("access-control-allow-headers", cors.allowedHeaders.join(","));
    } else if (req) {
      const acrh = req.headers.get("access-control-request-headers");
      if (acrh) headers.set("access-control-allow-headers", acrh);
    }

    // Credentials
    if (cors.allowCredentials) headers.set("access-control-allow-credentials", "true");

    // Expose headers
    if ((cors as { exposeHeaders?: string[] }).exposeHeaders?.length) {
      headers.set("access-control-expose-headers", (cors as { exposeHeaders?: string[] }).exposeHeaders!.join(","));
    }

    // Max-Age for preflight caching
    if ((cors as { maxAge?: number }).maxAge !== undefined) {
      headers.set("access-control-max-age", String((cors as { maxAge?: number }).maxAge));
    }
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

  const perfStart = performance.now();
  const resolved = await resolveRouter({ config }, resolver);
  // Optional user OTEL hooks
  try {
    const tracer = trace.getTracer("oxian", "1");
    const meter = metrics.getMeter("oxian", "1");
    await config.logging?.otel?.hooks?.onInit?.({ tracer, meter });
  } catch { /* ignore user hook errors */ }
  const perfEnd = performance.now();
  if (PERF) console.log('[perf][server] resolvedRouter', { ms: Math.round(perfEnd - perfStart) });
  const resolvedEnd = performance.now();
  if (PERF) console.log('[perf][server] resolvedRouter', { ms: Math.round(resolvedEnd - perfStart), isRemote: resolved.isRemote, routes: resolved.router?.routes?.length });

  if (PERF) console.log('[perf][server] listening', { port: config.server?.port ?? 8080 });
  const server = Deno.serve({ port: config.server?.port ?? 8080 }, async (req) => {
    const startedAt = performance.now();
    const hdrRequestId = config.logging?.requestIdHeader ? req.headers.get(config.logging.requestIdHeader) : undefined;
    const requestId = hdrRequestId || crypto.randomUUID();

    // Patch console to automatically inject request_id into all logs
    const restoreConsole = patchConsoleForRequest(requestId);

    try {
      // Run request handling within OTEL context for proper propagation
      return await context.with(context.active(), async () => {
        try {
        const url = new URL(req.url);
        // Prefer hypervisor-provided project header; fallback to config/runtime default
        const projectFromHv = req.headers.get("x-oxian-project") || "default";
        const basePath = config.basePath ?? "/";
        let path = url.pathname;

        // Root health endpoint independent of basePath for readiness probes
        if (req.method === "HEAD" && url.pathname === "/_health") {
          const headers = new Headers();
          applyCorsAndDefaults(headers, config, req);
          const res = new Response(null, { status: 200, headers });
          // minimal health response
          return res;
        }

        if (basePath && basePath !== "/") {
          if (!path.startsWith(basePath)) {
            // Non-API path: handle via web config (prefer top-level config.web; fallback to runtime.hv.web)
            const webCfg = (config.web ?? (config.runtime?.hv?.web ?? {})) as { devProxyTarget?: string; staticDir?: string; staticCacheControl?: string };
            if (webCfg.devProxyTarget) {
              try {
                const targetUrl = new URL(url.pathname + url.search, webCfg.devProxyTarget);
                const headers = new Headers(req.headers);
                try { headers.set("host", targetUrl.host); } catch { /* ignore */ }
                const res = await fetch(targetUrl.toString(), { method: req.method, headers, body: req.body });
                return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
             } catch (e) {
              console.error("web_dev_proxy_error", { err: (e as Error)?.message });
              return new Response("Dev proxy error", { status: 502 });
            }
            }
            if (webCfg.staticDir) {
              const cleaned = url.pathname.replace(/^\/+/, "");
              // Try static file
              try {
                const fileUrl = await resolver.resolve(`${webCfg.staticDir}/${cleaned}`);
                const file = await resolver.load(fileUrl);
                const headers = new Headers();
                const ct = guessContentType(fileUrl.pathname);
                if (ct) headers.set("content-type", ct);
                if (webCfg.staticCacheControl) headers.set("cache-control", webCfg.staticCacheControl);
                return new Response(file as string, { status: 200, headers });
              } catch {/* ignore and fallback to index */ }
              // SPA fallback
              try {
                const indexUrl = await resolver.resolve(`${webCfg.staticDir}/index.html`);
                const file = await resolver.load(indexUrl);
                const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
                if (webCfg.staticCacheControl) headers.set("cache-control", webCfg.staticCacheControl);
                return new Response(file as string, { status: 200, headers });
              } catch { /* ignore */ }
            }

            const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
            applyCorsAndDefaults(headers, config, req);
            return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers });
          }
          path = path.slice(basePath.length) || "/";
        }

        path = applyTrailingSlash(path, config.routing?.trailingSlash);

        // Lightweight health endpoint to avoid triggering route pipeline during readiness probes
        if (req.method === "HEAD" && path === "/_health") {
          const headers = new Headers();
          applyCorsAndDefaults(headers, config, req);
          const res = new Response(null, { status: 200, headers });
          return res;
        }

        // CORS preflight handling
        if (req.method === "OPTIONS") {
          const headers = new Headers();
          applyCorsAndDefaults(headers, config, req);
          return new Response(null, { status: 204, headers });
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
        applyCorsAndDefaults(state.headers, config, req);

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
          dependencies: { ...config?.runtime?.dependencies?.initial },
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
            return res;
          }
          // If no match found at any path, send a 404 response
          {
            const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
            applyCorsAndDefaults(headers, config, req);
            return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers });
          }
        }

        // Enrich active span with route, project, and request id (OTEL) and call user start hook
        try {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            const routePattern = (match as unknown as { route?: { pattern?: string } })?.route?.pattern ?? path;
            // Set span attributes using OpenTelemetry semantic conventions
            activeSpan.setAttribute("http.route", routePattern);
            activeSpan.setAttribute("oxian.project", projectFromHv);
            activeSpan.setAttribute("oxian.request_id", requestId);
            // Also set as span event for better visibility
            activeSpan.addEvent("request.start", {
              "request.id": requestId,
              "request.project": projectFromHv,
              "request.route": routePattern,
            });
            activeSpan.updateName(`${req.method} ${routePattern}`);

           // Call user start hook
             try {
               const tracer = trace.getTracer("oxian", "1");
               const meter = metrics.getMeter("oxian", "1");
               await config.logging?.otel?.hooks?.onRequestStart?.({ tracer, meter, span: activeSpan, requestId, method: req.method, url: req.url, project: projectFromHv });
             } catch (hookErr) {
               if (Deno.env.get("OXIAN_DEBUG")) {
                 console.error("[server] OTEL user hook error", { error: hookErr });
               }
             }
           } else {
             // Log when span is not available for debugging
             if (Deno.env.get("OXIAN_DEBUG")) {
               console.warn("[server] No active OTEL span found for request", { path });
             }
           }
         } catch (spanErr) {
           // Log span errors in debug mode instead of silently ignoring
           if (Deno.env.get("OXIAN_DEBUG")) {
             console.error("[server] OTEL span error", { error: spanErr });
           }
         }

        // Unified pipeline discovery
        let files;
        const getFilesStart = performance.now();
        if (resolved.isRemote && resolved.routesRootUrl) {
          const chain = await buildRemoteChain(resolver, (match as unknown as { route: { fileUrl: URL } }).route.fileUrl);
          files = await discoverPipelineFiles(chain, resolver, { allowShared: config.compatibility?.allowShared });
        } else {
          const chain = await buildLocalChain(resolver, config.routing?.routesDir ?? "routes", (match as unknown as { route: { fileUrl: URL } }).route.fileUrl);
          files = await discoverPipelineFiles(chain, resolver, { allowShared: config.compatibility?.allowShared });
        }
        const getFilesEnd = performance.now();
        if (PERF) console.log('[perf][server] discoverPipelineFiles', { ms: Math.round(getFilesEnd - getFilesStart) });

        try {

          // Inject config-defined deps as the base
          const baseDeps = { };
          context.dependencies = baseDeps;
          // Compose route dependencies on top
          const composeStart = performance.now();
          const composed = await composeDependencies(files, { baseDeps }, resolver, { allowShared: config.compatibility?.allowShared });
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
           console.error("pipeline_error", {
             err: (err as Error)?.message,
             stack: (err as Error)?.stack
           });
           const shaped = shapeError(err as unknown);
           state.status = shaped.status;
           state.body = shaped.body;
           const res = finalizeResponse(state);
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
        try {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            // Add final attributes and event to span
            activeSpan.setAttribute("http.response.status_code", res.status);
            activeSpan.setAttribute("oxian.request.duration_ms", Math.round(performance.now() - startedAt));
            activeSpan.addEvent("request.end", {
              "request.id": requestId,
              "response.status": res.status,
              "request.duration_ms": Math.round(performance.now() - startedAt),
            });
          }

          // Call user end hook
          const tracer = trace.getTracer("oxian", "1");
          const meter = metrics.getMeter("oxian", "1");
          await config.logging?.otel?.hooks?.onRequestEnd?.({
            tracer,
            meter,
            span: activeSpan ?? undefined,
            requestId,
            method: req.method,
            url: req.url,
            project: projectFromHv,
            status: res.status,
            durationMs: Math.round(performance.now() - startedAt)
          });
         } catch (hookErr) {
           if (Deno.env.get("OXIAN_DEBUG")) {
             console.error("[server] OTEL end hook error", { error: hookErr });
           }
         }
         return res;

       } catch (err) {
         console.error("unhandled", { err: (err as Error).message });

        // Mark span as error in OTEL
        try {
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            activeSpan.recordException(err as Error);
            activeSpan.setStatus({ code: 2, message: (err as Error).message }); // code 2 = ERROR
            activeSpan.setAttribute("oxian.request_id", requestId);
            activeSpan.addEvent("request.error", {
              "request.id": requestId,
              "error.message": (err as Error).message,
              "error.type": (err as Error).constructor.name,
            });
          }
         } catch (spanErr) {
           if (Deno.env.get("OXIAN_DEBUG")) {
             console.error("[server] OTEL error span update failed", { error: spanErr });
           }
         }

         const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
         applyCorsAndDefaults(headers, config, req);
         return new Response(JSON.stringify({ error: { message: "Internal Server Error" } }), { status: 500, headers });
       }
      }); // Close context.with()
    } finally {
      // Always restore original console methods
      restoreConsole();
    }
  });

  if (PERF) console.log('[perf][server] listening', { port: config.server?.port ?? 8080 });
  await server.finished;
} 