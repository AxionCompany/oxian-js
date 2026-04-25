/**
 * @fileoverview Pipeline executor for the Oxian framework.
 *
 * This module encapsulates the full request pipeline: discovering pipeline files,
 * composing dependencies, running interceptors and middleware, loading the route
 * module, and executing the handler. It is the core abstraction that separates
 * "what to execute" from the HTTP layer.
 *
 * @module runtime/executor
 */

import type { EffectiveConfig } from "../config/index.ts";
import type { Context, Handler } from "../core/index.ts";
import type { Data } from "../core/data.ts";
import type { RouteRecord } from "../router/types.ts";
import type { ResponseState } from "../server/types.ts";
import type { Resolver } from "../resolvers/types.ts";
import type { PipelineFiles } from "./types.ts";

import { composeDependencies } from "./dependencies.ts";
import {
  runInterceptorsAfter,
  runInterceptorsBefore,
} from "./interceptors.ts";
import { runMiddlewares } from "./middlewares.ts";
import { getHandlerExport, loadRouteModule } from "./module_loader.ts";
import { runHandler, shapeError } from "./pipeline.ts";
import {
  buildLocalChain,
  buildRemoteChain,
  discoverPipelineFiles,
} from "./pipeline_discovery.ts";

// ---------------------------------------------------------------------------
// Pipeline files cache — keyed by route file URL.
// For a given route file, the pipeline files (dependencies, middleware,
// interceptors) are determined by the directory chain and don't change
// between requests. Call clearPipelineCache() on hot-reload events.
// ---------------------------------------------------------------------------

const pipelineFilesCache = new Map<string, PipelineFiles>();

export function clearPipelineCache(): void {
  pipelineFilesCache.clear();
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

export type PipelineInput = {
  /** The matched route record */
  route: RouteRecord;
  /** Merged request data (body + query + path params) */
  data: Data;
  /** Request context (with response controller already attached) */
  context: Context;
  /** Internal response state (shared with the response controller) */
  state: ResponseState;
  /** HTTP method from the original request */
  method: string;
  /** Effective config */
  config: EffectiveConfig;
  /** Source resolver */
  resolver: Resolver;
  /** Whether routes come from a remote source */
  isRemote: boolean;
  /** Root URL of the routes directory */
  routesRootUrl?: URL;
};

export type PipelineResult = {
  /** The handler result or error (passed to afterRun interceptors) */
  resultOrError?: unknown;
  /** Mutated data after middleware/interceptors */
  data: Data;
  /** Mutated context after middleware/interceptors */
  context: Context;
};

/**
 * Executes the full Oxian request pipeline for a matched route.
 *
 * Pipeline stages:
 * 1. Discover pipeline files (dependencies, middleware, interceptors)
 * 2. Compose dependencies
 * 3. Run interceptors (beforeRun)
 * 4. Run middlewares
 * 5. Load route module and resolve handler export
 * 6. Execute handler
 * 7. Run interceptors (afterRun)
 */
export async function executePipeline(
  input: PipelineInput,
): Promise<PipelineResult> {
  const {
    route,
    state,
    method,
    config,
    resolver,
    isRemote,
    routesRootUrl,
  } = input;
  let { data, context } = input;

  const PERF = config.logging?.performance === true;

  // 1. Discover pipeline files (cached per route file URL)
  const cacheKey = route.fileUrl.toString();
  let files = pipelineFilesCache.get(cacheKey);

  if (!files) {
    const t0 = performance.now();
    if (isRemote && routesRootUrl) {
      const chain = await buildRemoteChain(resolver, route.fileUrl);
      files = await discoverPipelineFiles(chain, resolver, {
        allowShared: config.compatibility?.allowShared,
      });
    } else {
      const chain = await buildLocalChain(
        resolver,
        config.routing?.routesDir ?? "routes",
        route.fileUrl,
      );
      files = await discoverPipelineFiles(chain, resolver, {
        allowShared: config.compatibility?.allowShared,
      });
    }
    pipelineFilesCache.set(cacheKey, files);
    if (PERF) {
      console.log("[perf][pipeline] discoverPipelineFiles", {
        ms: Math.round(performance.now() - t0),
      });
    }
  }

  // 2-4. Compose dependencies, run interceptors (before), run middlewares
  try {
    const baseDeps = {};
    context.dependencies = baseDeps;

    const t0 = performance.now();
    const composed = await composeDependencies(
      files,
      { baseDeps },
      resolver,
      { allowShared: config.compatibility?.allowShared },
    );
    context.dependencies = { ...baseDeps, ...composed };
    if (PERF) {
      console.log("[perf][pipeline] composeDependencies", {
        ms: Math.round(performance.now() - t0),
      });
    }

    {
      const t0 = performance.now();
      const result = await runInterceptorsBefore(
        files.interceptorFiles,
        data,
        context,
        resolver,
      );
      data = result.data;
      context = result.context as Context;
      if (PERF) {
        console.log("[perf][pipeline] runInterceptorsBefore", {
          ms: Math.round(performance.now() - t0),
        });
      }
    }

    {
      const t0 = performance.now();
      const result = await runMiddlewares(
        files.middlewareFiles,
        data,
        context,
        resolver,
        config,
      );
      data = result.data;
      context = result.context as Context;
      if (PERF) {
        console.log("[perf][pipeline] runMiddlewares", {
          ms: Math.round(performance.now() - t0),
        });
      }
    }
  } catch (err) {
    console.error("pipeline_error", {
      err: (err as Error)?.message,
      stack: (err as Error)?.stack,
    });
    const shaped = shapeError(err as unknown, {
      verboseErrors: config.logging?.verboseErrors,
    });
    state.status = shaped.status;
    state.body = shaped.body;
    return { resultOrError: err, data, context };
  }

  // 5. Load route module and resolve handler
  const t0 = performance.now();
  const mod = await loadRouteModule(route.fileUrl, resolver);
  if (PERF) {
    console.log("[perf][pipeline] loadRouteModule", {
      ms: Math.round(performance.now() - t0),
    });
  }

  let exportVal = getHandlerExport(mod, method);
  // RFC 7231: HEAD must be handled like GET but with no response body
  const isHead = method === "HEAD";
  if (isHead && typeof exportVal !== "function") {
    exportVal = getHandlerExport(mod, "GET");
  }

  // 6. Execute handler
  let resultOrError: unknown = undefined;
  if (typeof exportVal !== "function") {
    state.status = 405;
    state.body = { error: { message: "Method Not Allowed" } };
    resultOrError = new Error("Method Not Allowed");
  } else {
    const t0 = performance.now();
    const { result, error } = await runHandler(
      exportVal as Handler,
      data as Record<string, unknown>,
      context,
      state,
      { verboseErrors: config.logging?.verboseErrors },
    );
    resultOrError = error ?? result;
    if (PERF) {
      console.log("[perf][pipeline] runHandler", {
        ms: Math.round(performance.now() - t0),
      });
    }
  }

  // 7. Run after interceptors
  {
    const t0 = performance.now();
    await runInterceptorsAfter(
      files.interceptorFiles,
      resultOrError,
      context,
      resolver,
    );
    if (PERF) {
      console.log("[perf][pipeline] runInterceptorsAfter", {
        ms: Math.round(performance.now() - t0),
      });
    }
  }

  // Strip body for HEAD requests (RFC 7231 §4.3.2)
  if (isHead) {
    state.body = null;
  }

  return { resultOrError, data, context };
}
