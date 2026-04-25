/**
 * @fileoverview Core HTTP server implementation for the Oxian framework.
 *
 * This module provides the main server functionality including request handling,
 * routing, and response processing. Pipeline execution (dependency injection,
 * middleware, interceptors, handler) is delegated to the runtime executor.
 *
 * @module server
 */

import type { EffectiveConfig } from "../config/index.ts";
// Use console.* for OTEL log export (Deno only supports console, not Logs API)
import { context, metrics, trace } from "npm:@opentelemetry/api@1";

import {
  createResponseController,
  finalizeResponse,
} from "../utils/response.ts";
import { mergeData, parseQuery, parseRequestBody } from "../utils/request.ts";
import type { Context, Data } from "../core/index.ts";
import { resolveRouter } from "../router/index.ts";
import { executePipeline } from "../runtime/executor.ts";
import type { Resolver } from "../resolvers/types.ts";

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
function applyTrailingSlash(
  path: string,
  mode: "always" | "never" | "preserve" | undefined,
): string {
  if (mode === "preserve" || !mode) return path;
  if (mode === "always") return path.endsWith("/") ? path : path + "/";
  if (mode === "never") {
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  }
  return path;
}

function applyCorsAndDefaults(
  headers: Headers,
  config: EffectiveConfig,
  req?: Request,
) {
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
    const methods = cors.methods?.length
      ? cors.methods
      : ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
    headers.set("access-control-allow-methods", methods.join(","));

    // Allowed headers (echo request if not configured)
    if (cors.allowedHeaders?.length) {
      headers.set(
        "access-control-allow-headers",
        cors.allowedHeaders.join(","),
      );
    } else if (req) {
      const acrh = req.headers.get("access-control-request-headers");
      if (acrh) headers.set("access-control-allow-headers", acrh);
    }

    // Credentials
    if (cors.allowCredentials) {
      headers.set("access-control-allow-credentials", "true");
    }

    // Expose headers
    if ((cors as { exposeHeaders?: string[] }).exposeHeaders?.length) {
      headers.set(
        "access-control-expose-headers",
        (cors as { exposeHeaders?: string[] }).exposeHeaders!.join(","),
      );
    }

    // Max-Age for preflight caching
    if ((cors as { maxAge?: number }).maxAge !== undefined) {
      headers.set(
        "access-control-max-age",
        String((cors as { maxAge?: number }).maxAge),
      );
    }
  }
  const defaults = config.security?.defaultHeaders;
  if (defaults) {
    for (const [k, v] of Object.entries(defaults)) {
      headers.set(k.toLowerCase(), v);
    }
  }
}

/**
 * Starts the Oxian HTTP server with the provided configuration.
 *
 * This function initializes and starts a complete HTTP server that handles routing,
 * CORS, static serving, and delegates request processing to the pipeline executor.
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
export async function startServer(
  opts: { config: EffectiveConfig; source?: string },
  resolver: Resolver,
) {
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
  if (PERF) {
    console.log("[perf][server] resolvedRouter", {
      ms: Math.round(performance.now() - perfStart),
      isRemote: resolved.isRemote,
      routes: resolved.router?.routes?.length,
    });
  }

  if (PERF) {
    console.log("[perf][server] listening", {
      port: config.server?.port ?? 8080,
    });
  }
  const server = Deno.serve(
    { port: config.server?.port ?? 8080 },
    async (req) => {
      const startedAt = performance.now();

      // Run request handling within OTEL context for proper propagation
      return await context.with(context.active(), async () => {
        // Use spanId as requestId for automatic trace correlation
        const activeSpan = trace.getActiveSpan();
        const spanContext = activeSpan?.spanContext();
        const hdrRequestId = config.logging?.requestIdHeader
          ? req.headers.get(config.logging.requestIdHeader)
          : undefined;
        const requestId = hdrRequestId || spanContext?.spanId ||
          crypto.randomUUID();
        try {
          const url = new URL(req.url);
          // Reconstruct original URL when behind hypervisor using X-Forwarded-* headers
          const xfProto = req.headers.get("x-forwarded-proto");
          const xfHost = req.headers.get("x-forwarded-host");
          const xfPath = req.headers.get("x-forwarded-path");
          const xfQuery = req.headers.get("x-forwarded-query");
          const originalUrl = xfProto && xfHost
            ? `${xfProto}://${xfHost}${xfPath || url.pathname}${
              xfQuery ? `?${xfQuery}` : url.search
            }`
            : req.url;
          // Prefer hypervisor-provided service header; fallback to default
          const serviceFromHv = req.headers.get("x-oxian-service") || "default";
          const basePath = config.basePath ?? "/";
          let path = url.pathname;

          // Root health endpoint independent of basePath for readiness probes
          if (req.method === "HEAD" && url.pathname === "/_health") {
            const headers = new Headers();
            applyCorsAndDefaults(headers, config, req);
            return new Response(null, { status: 200, headers });
          }

          if (basePath && basePath !== "/") {
            if (!path.startsWith(basePath)) {
              // Non-API path: handle via web config (prefer top-level config.web; fallback to runtime.hv.web)
              const webCfg = config.web ?? (config.runtime?.hv?.web ?? {});
              if (webCfg.devProxyTarget) {
                try {
                  const targetUrl = new URL(
                    url.pathname + url.search,
                    webCfg.devProxyTarget,
                  );
                  const headers = new Headers(req.headers);
                  try {
                    headers.set("host", targetUrl.host);
                  } catch { /* ignore */ }
                  const res = await fetch(targetUrl.toString(), {
                    method: req.method,
                    headers,
                    body: req.body,
                  });
                  return new Response(res.body, {
                    status: res.status,
                    statusText: res.statusText,
                    headers: res.headers,
                  });
                } catch (e) {
                  console.error("web_dev_proxy_error", {
                    err: (e as Error)?.message,
                  });
                  return new Response("Dev proxy error", { status: 502 });
                }
              }
              if (webCfg.staticDir) {
                const cleaned = webCfg.pathRewrite
                  ? webCfg.pathRewrite(url.href, "")
                  : url.pathname.replace(/^\/+/, "");
                // Try static file
                try {
                  const fileUrl = await resolver.resolve(
                    `${webCfg.staticDir}/${cleaned}`,
                  );
                  const file = await resolver.load(fileUrl, { encoding: null });
                  const headers = new Headers();
                  const ct = guessContentType(fileUrl.pathname);
                  if (ct) headers.set("content-type", ct);
                  if (webCfg.staticCacheControl) {
                    headers.set("cache-control", webCfg.staticCacheControl);
                  }
                  return new Response(file as string, { status: 200, headers });
                } catch {
                  /* ignore and fallback to index */
                }
                // SPA fallback
                try {
                  const indexUrl = await resolver.resolve(
                    `${webCfg.staticDir}/${webCfg.staticIndex ?? "index.html"}`,
                  );
                  const file = await resolver.load(indexUrl, {
                    encoding: null,
                  });
                  const headers = new Headers({
                    "content-type": "text/html; charset=utf-8",
                  });
                  if (webCfg.staticCacheControl) {
                    headers.set("cache-control", webCfg.staticCacheControl);
                  }
                  return new Response(file as string, { status: 200, headers });
                } catch { /* ignore */ }
              }

              const headers = new Headers({
                "content-type": "application/json; charset=utf-8",
              });
              applyCorsAndDefaults(headers, config, req);
              return new Response(
                JSON.stringify({ error: { message: "Not found" } }),
                { status: 404, headers },
              );
            }
            path = path.slice(basePath.length) || "/";
          }

          path = applyTrailingSlash(path, config.routing?.trailingSlash);

          // Lightweight health endpoint to avoid triggering route pipeline during readiness probes
          if (req.method === "HEAD" && path === "/_health") {
            const headers = new Headers();
            applyCorsAndDefaults(headers, config, req);
            return new Response(null, { status: 200, headers });
          }

          // CORS preflight handling
          if (req.method === "OPTIONS") {
            const headers = new Headers();
            applyCorsAndDefaults(headers, config, req);
            return new Response(null, { status: 204, headers });
          }

          // Route matching (unified async interface)
          const matchStart = performance.now();
          const match = await resolved.router.match(path);
          if (PERF) {
            console.log("[perf][server] routeMatch", {
              ms: Math.round(performance.now() - matchStart),
            });
          }

          // Parse request
          const { params: queryParams, record: queryRecord } = parseQuery(url);
          const rawClone = req.clone();
          let rawBody: Uint8Array | undefined = undefined;
          try {
            const bodyClone = req.clone();
            const ab = await bodyClone.arrayBuffer();
            rawBody = new Uint8Array(ab);
          } catch {
            /* Swallow errors reading raw body; continue with parsed body only */
          }
          const body = await parseRequestBody(req);
          const pathParams = match?.params ?? {};
          const data: Data = mergeData(pathParams, queryRecord, body);

          // Create response controller and apply CORS/default headers
          const { controller, state } = createResponseController();
          applyCorsAndDefaults(state.headers, config, req);

          const routePattern = match?.route?.pattern ?? path;

          const ctx: Context = {
            requestId,
            request: {
              method: req.method,
              url: originalUrl,
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
            oxian: {
              route: routePattern,
              startedAt,
            },
            // pass compatibility options for handler modes
            ...(config.compatibility
              ? { compat: config.compatibility } as Record<string, unknown>
              : {}),
          };

          if (!match) {
            if (path === "/") {
              controller.send({
                ok: true,
                message: "Oxian running",
                routes: resolved.router.routes.map((r) => r.pattern),
              });
              return finalizeResponse(state);
            }
            const headers = new Headers({
              "content-type": "application/json; charset=utf-8",
            });
            applyCorsAndDefaults(headers, config, req);
            return new Response(
              JSON.stringify({ error: { message: "Not found" } }),
              { status: 404, headers },
            );
          }

          // OTEL: enrich active span and record per-request metrics
          try {
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
              activeSpan.setAttributes({
                "http.route": routePattern,
                "oxian.service": serviceFromHv,
              });
              activeSpan.updateName(`${req.method} ${routePattern}`);

              const meter = metrics.getMeter("oxian", "1");
              const attrs = {
                "http.route": routePattern,
                "http.method": req.method,
                "oxian.service": serviceFromHv,
              } as Record<string, string | number>;
              try {
                meter.createUpDownCounter("http.server.active_requests", { unit: "1" }).add(1, attrs);
                meter.createCounter("http.server.requests", { unit: "1" }).add(1, attrs);
              } catch { /* avoid hard failure if meter not available */ }

              try {
                const tracer = trace.getTracer("oxian", "1");
                const meterHook = metrics.getMeter("oxian", "1");
                await config.logging?.otel?.hooks?.onRequestStart?.({
                  tracer,
                  meter: meterHook,
                  span: activeSpan,
                  requestId,
                  method: req.method,
                  url: req.url,
                  service: serviceFromHv,
                });
              } catch (hookErr) {
                if (Deno.env.get("OXIAN_DEBUG")) {
                  console.log("[server] OTEL user hook error", { error: hookErr });
                }
              }
            } else if (Deno.env.get("OXIAN_DEBUG")) {
              console.log("[server] No active OTEL span found for request", { path });
            }
          } catch (spanErr) {
            if (Deno.env.get("OXIAN_DEBUG")) {
              console.log("[server] OTEL span error", { error: spanErr });
            }
          }

          // Execute the pipeline (deps → interceptors → middleware → handler)
          await executePipeline({
            route: match.route,
            data,
            context: ctx,
            state,
            method: req.method,
            config,
            resolver,
            isRemote: resolved.isRemote,
            routesRootUrl: resolved.routesRootUrl,
          });

          // Finalize response
          const res = finalizeResponse(state);
          if (PERF) {
            console.log("[perf][server] requestComplete", {
              ms: Math.round(performance.now() - startedAt),
            });
          }

          // OTEL: record end metrics
          try {
            const activeSpan = trace.getActiveSpan();
            if (activeSpan) {
              activeSpan.setAttributes({
                "http.response.status_code": res.status,
                "oxian.request.duration_ms": Math.round(performance.now() - startedAt),
              });

              const meter = metrics.getMeter("oxian", "1");
              const attrs = {
                "http.route": routePattern,
                "http.method": req.method,
                "http.status_code": res.status,
                "oxian.service": serviceFromHv,
              } as Record<string, string | number>;
              try {
                meter.createUpDownCounter("http.server.active_requests", { unit: "1" }).add(-1, attrs);
                meter.createHistogram("http.server.request.duration", { unit: "ms" })
                  .record(Math.round(performance.now() - startedAt), attrs);
              } catch { /* ignore */ }
            }

            const tracer = trace.getTracer("oxian", "1");
            const meter = metrics.getMeter("oxian", "1");
            await config.logging?.otel?.hooks?.onRequestEnd?.({
              tracer,
              meter,
              span: activeSpan ?? undefined,
              requestId,
              method: req.method,
              url: req.url,
              service: serviceFromHv,
              status: res.status,
              durationMs: Math.round(performance.now() - startedAt),
            });
          } catch (hookErr) {
            if (Deno.env.get("OXIAN_DEBUG")) {
              console.log("[server] OTEL end hook error", { error: hookErr });
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
              activeSpan.setStatus({
                code: 2,
                message: (err as Error).message,
              });
              activeSpan.addEvent("request.error", {
                "request.id": requestId,
                "error.message": (err as Error).message,
                "error.type": (err as Error).constructor.name,
              });
            }
          } catch (spanErr) {
            if (Deno.env.get("OXIAN_DEBUG")) {
              console.log("[server] OTEL error span update failed", { error: spanErr });
            }
          }

          const headers = new Headers({
            "content-type": "application/json; charset=utf-8",
          });
          applyCorsAndDefaults(headers, config, req);
          return new Response(
            JSON.stringify({ error: { message: "Internal Server Error" } }),
            { status: 500, headers },
          );
        }
      }); // Close context.with()
    },
  );

  if (PERF) {
    console.log("[perf][server] listening", {
      port: config.server?.port ?? 8080,
    });
  }
  await server.finished;
}
