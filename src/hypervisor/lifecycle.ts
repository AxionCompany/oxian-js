import type { EffectiveConfig } from "../config/index.ts";
import { createResolver } from "../resolvers/index.ts";
import type {
  HypervisorPlugin,
  HypervisorStore,
  PluginContext,
  ServiceDefinition,
} from "./types.ts";
import { MemoryStore } from "./store.ts";
import { getLocalRootPath } from "../utils/root.ts";
import { join } from "@std/path";

function splitBaseArgs(
  baseArgs: string[],
): { denoOptions: string[]; scriptArgs: string[] } {
  const denoOptions: string[] = [];
  const scriptArgs: string[] = [];
  for (const a of baseArgs) {
    if (a.startsWith("--deno-config=")) {
      const cfg = a.split("=")[1];
      if (cfg) {
        denoOptions.push("--config", cfg);
      }
      continue;
    }
    if (a.startsWith("--deno-import-map=")) {
      const im = a.split("=")[1];
      if (im) denoOptions.push("--import-map", im);
      continue;
    }
    scriptArgs.push(a);
  }
  return { denoOptions, scriptArgs };
}
export async function startHypervisor(
  { config, baseArgs }: { config: EffectiveConfig; baseArgs: string[] },
  plugin?: HypervisorPlugin,
  store?: HypervisorStore,
) {
  const hv = config.runtime?.hv ?? {};
  const publicPort = config.server?.port ?? 8080;
  const PERF = config.logging?.performance === true;
  const effectiveStore = store ?? new MemoryStore();

  // Queue item shape stored in the store
  type QueueItem = { req: Request; enqueuedAt: number };

  const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);

  // Initialize plugin if provided
  if (plugin?.init) {
    await plugin.init({
      config,
      resolver: createResolver(config.root, {}),
      denoOptions,
      scriptArgs,
    });
  }

  // Lifecycle manager centralizes worker pools and restarts
  const manager = createLifecycleManager({
    config,
    plugin,
    store: effectiveStore,
    onServiceReady: async (service) => {
      try {
        await flushQueue(service);
      } catch { /* ignore */ }
    },
  });
  manager.setBaseArgs(denoOptions, scriptArgs);

  const OTEL_OR_COLLECTOR = (config.logging?.otel?.enabled === true) ||
    (hv.otelCollector?.enabled === true) || (hv.otelProxy?.enabled === true);
  if (PERF) {
    console.log("[perf][hv] public listening", {
      service: "default",
      port: publicPort,
    });
  }
  // Start idle checker to reap idle workers
  manager.startIdleChecker();
  // Optional built-in OTLP HTTP collector

  let otelProxyServer: Deno.HttpServer | undefined;
  if (hv.otelProxy?.enabled) {
    const proxyPort = hv.otelProxy.port ?? 4318;
    const prefix = (hv.otelProxy.pathPrefix ?? "/v1").replace(/\/$/, "");
    const upstream = hv.otelProxy.upstream || config.logging.otel?.endpoint;
    const onReq = hv.otelProxy.onRequest;
    const routes = new Map<string, "traces" | "metrics" | "logs">([
      ["/traces", "traces"],
      ["/metrics", "metrics"],
      ["/logs", "logs"],
    ]);
    otelProxyServer = Deno.serve({ port: proxyPort }, async (req) => {
      const url = new URL(req.url);
      const trimmed = url.pathname.startsWith(prefix)
        ? url.pathname.slice(prefix.length)
        : url.pathname;
      const kind = routes.get(trimmed);
      if (!kind) return new Response("Not found", { status: 404 });
      const serviceFromHeader = req.headers.get("x-oxian-service") || undefined;
      let shouldForward = true;
      try {
        if (typeof onReq === "function") {
          const reqForHook = req.clone();
          shouldForward = await onReq({
            kind,
            req: reqForHook,
            service: serviceFromHeader,
          });
        }
      } catch { /* ignore user callback errors; default to forward */ }
      if (!shouldForward || !upstream) {
        return new Response(null, { status: 202 });
      }
      const fwdUrl = upstream.replace(/\/$/, "") + trimmed;
      const fwdHeaders = new Headers(req.headers);
      try {
        if (serviceFromHeader) {
          fwdHeaders.set("x-oxian-service", serviceFromHeader);
        }
      } catch { /* ignore */ }
      const fwdReq = new Request(fwdUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: (req.method === "GET" || req.method === "HEAD")
          ? undefined
          : req.body ?? undefined,
      });
      try {
        const fwdRes = await fetch(fwdReq);
        return new Response(null, { status: fwdRes.status || 202 });
      } catch { /* ignore upstream errors, respond 202 to exporter */ }
      return new Response(null, { status: 202 });
    });
  }

  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

    // ── Forward mechanism: skip provider, route to local worker ────────
    const forwardService = req.headers.get("x-oxian-forward");
    if (forwardService) {
      const fwdTarget = await manager.getTarget(forwardService);
      if (!fwdTarget) {
        return new Response(
          JSON.stringify({ error: { message: "Forwarded service not found on this instance" } }),
          { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
      const pathname = url.pathname;
      const target = `${fwdTarget}${pathname}${url.search}`;
      return await fetch(target, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: "manual",
        duplex: "half",
      } as RequestInit);
    }

    // Route via provider (defaults to "default" service when no provider is set)
    let selected: ServiceDefinition = { service: "default" };
    try {
      if (typeof hv.provider === "function") {
        selected = await hv.provider(req);
      }
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: { message: (e as Error)?.message || "Admission rejected" },
        }),
        {
          status: 403,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    // ── Target short-circuit: proxy directly to pre-known target ──────
    if (selected.target) {
      const pathname = url.pathname;
      const proxyUrl = `${selected.target}${pathname}${url.search}`;
      try {
        return await fetch(proxyUrl, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          redirect: "manual",
          duplex: "half",
        } as RequestInit);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: { message: (e as Error)?.message || "Target unreachable" } }),
          { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
    }

    // All requests are proxied to the selected worker

    let serviceTarget = await manager.getTarget(selected.service);
    const queueCfg = hv.queue ?? {};
    if (!serviceTarget) {
      // On-demand spawn
      try {
        const idx = manager.getServiceIndex(selected.service) ?? 0;
        await manager.spawnWorker(selected, idx);
        serviceTarget = await manager.getTarget(selected.service);
      } catch (_e) {
        // fallback to queue/wait logic
      }
      // Always enqueue request while waiting for worker readiness
      return await enqueueAndWait(
        selected.service,
        req,
        queueCfg.maxItems ?? 100,
        queueCfg.maxBodyBytes ?? 1_048_576,
        queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000),
      );
    }

    if (!serviceTarget) {
      const body = JSON.stringify({
        error: { message: "No worker available" },
      });
      return new Response(body, {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // If provider invalidation timestamp changed/newer, restart worker before proxying.
    try {
      if (await manager.shouldRestartForCacheInvalidation(selected.service, selected)) {
        await manager.restartService(
          selected.service,
          undefined,
          undefined,
          selected,
        );
        serviceTarget = await manager.getTarget(selected.service);
      }
    } catch { /* ignore invalidation restart errors and continue */ }

    if (!serviceTarget) {
      const body = JSON.stringify({
        error: { message: "No worker available" },
      });
      return new Response(body, {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const pathname = url.pathname;
    const target = `${serviceTarget}${pathname}${url.search}`;

    // Apply request transformation hook if provided
    let transformedReq = req;
    if (typeof hv.onRequest === "function") {
      try {
        transformedReq = await hv.onRequest({ req, service: selected.service });
      } catch (e) {
        console.error(`[hv] onRequest callback error`, {
          service: selected.service,
          err: (e as Error)?.message,
        });
        return new Response(
          JSON.stringify({
            error: { message: "Request transformation failed" },
          }),
          {
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
    }

    // Buffer request body before proxy fetch so retry can reuse it (Fix B)
    let bufferedBody: Uint8Array | null = null;
    const reqMethod = transformedReq.method;
    const hasBody = reqMethod !== "GET" && reqMethod !== "HEAD" &&
      transformedReq.body;
    if (hasBody) {
      try {
        const [forFetch, forBuffer] = transformedReq.body!.tee();
        transformedReq = new Request(transformedReq, {
          body: forFetch,
          headers: transformedReq.headers,
        });
        const reader = forBuffer.getReader();
        const chunks: Uint8Array[] = [];
        let totalLen = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            totalLen += value.byteLength;
          }
        }
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        bufferedBody = merged;
      } catch {
        // If tee fails (body already consumed), proceed without buffer
        bufferedBody = null;
      }
    }

    const headers = new Headers(transformedReq.headers);
    // Preserve original client information for the worker
    const orig = new URL(req.url);
    headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));
    headers.set("x-forwarded-host", orig.host);
    headers.set(
      "x-forwarded-port",
      orig.port || (orig.protocol === "https:" ? "443" : "80"),
    );
    headers.set("x-forwarded-path", orig.pathname);
    headers.set("x-forwarded-query", orig.search.replace(/^\?/, ""));
    if (hv.proxy?.passRequestId) {
      const hdr = config.logging?.requestIdHeader ?? "x-request-id";
      if (!headers.has(hdr)) headers.set(hdr, crypto.randomUUID());
    }
    // Always forward selected service to worker for logging/metrics
    try {
      headers.set("x-oxian-service", selected.service);
    } catch { /* ignore */ }

    try {
      const p0 = performance.now();
      if (!PERF && OTEL_OR_COLLECTOR) {
        console.log(`[hv] proxy`, {
          service: selected.service,
          method: transformedReq.method,
          url: url.toString(),
          target,
        });
      }
      const abortTimeoutMs = hv.proxy?.timeoutMs ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), abortTimeoutMs);
      // Track inflight and activity for idle decisions. We consider request active until response body completes.
      manager.incrementServiceInflight(selected.service);
      manager.markServiceActivity(selected.service);
      const res = await fetch(target, {
        method: transformedReq.method,
        headers,
        body: transformedReq.body,
        signal: controller.signal,
        redirect: "manual",
        // Enable streaming request body for large uploads
        duplex: "half",
      } as RequestInit);
      clearTimeout(timer);
      if (PERF) {
        console.log("[perf][hv] proxy_res", {
          service: selected.service,
          status: res.status,
          target,
          ms: Math.round(performance.now() - p0),
        });
      }
      const body = res.body;
      if (!body) {
        manager.decrementServiceInflight(selected.service);
        manager.markServiceActivity(selected.service);
        return new Response(null, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      const tee = body.tee();
      const proxied = tee[0];
      const watcher = tee[1];
      (async () => {
        try {
          const reader = watcher.getReader();
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* ignore */
        } finally {
          manager.decrementServiceInflight(selected.service);
          manager.markServiceActivity(selected.service);
        }
      })();
      return new Response(proxied, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (e) {
      // Always log proxy errors regardless of OTEL config (Fix E)
      console.error(`[hv] proxy_err`, {
        service: selected.service,
        target,
        errName: (e as Error)?.name,
        err: (e as Error)?.message,
      });
      // Fix C: always decrement inflight on proxy failure
      manager.decrementServiceInflight(selected.service);

      // Fix A: distinguish timeout from connection errors
      const isTimeout = (e as Error)?.name === "AbortError" ||
        (e as Error)?.name === "TimeoutError";

      if (isTimeout) {
        // Worker may still be healthy; return 504 without killing it
        return new Response(
          JSON.stringify({ error: { message: "Gateway Timeout" } }),
          {
            status: 504,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }

      // Connection error → worker is likely dead, restart + re-enqueue
      try {
        await manager.restartService(selected.service);
      } catch { /* ignore */ }
      // Fix B: use buffered body for retry instead of consumed req
      const retryReq = bufferedBody
        ? new Request(req, {
          body: bufferedBody as unknown as BodyInit,
          headers: req.headers,
        })
        : req;
      return await enqueueAndWait(
        selected.service,
        retryReq,
        queueCfg.maxItems ?? 100,
        queueCfg.maxBodyBytes ?? 1_048_576,
        queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000),
      );
    }
  });

  async function flushQueue(service: string) {
    const items = await effectiveStore.drain<QueueItem>(`queue:${service}`);
    if (items.length === 0) return;
    const svcTarget = await manager.getTarget(service);
    if (!svcTarget) return; // still not ready
    // Reset queue size counter after draining
    await effectiveStore.set(`queue-size:${service}`, 0);
    for (const { id, item: { req, enqueuedAt } } of items) {
      const now = Date.now();
      const maxWait = hv.queue?.maxWaitMs ?? 2_000;
      if (now - enqueuedAt > maxWait) {
        await effectiveStore.resolve<Response>(id,
          new Response(
            JSON.stringify({ error: { message: "Queue wait timeout" } }),
            {
              status: 503,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          ),
        );
        continue;
      }
      try {
        // Apply request transformation hook if provided
        let transformedReq = req;
        if (typeof hv.onRequest === "function") {
          try {
            transformedReq = await hv.onRequest({ req, service });
          } catch (_e) {
            await effectiveStore.resolve<Response>(id,
              new Response(
                JSON.stringify({
                  error: { message: "Request transformation failed" },
                }),
                {
                  status: 500,
                  headers: {
                    "content-type": "application/json; charset=utf-8",
                  },
                },
              ),
            );
            continue;
          }
        }
        const url = new URL(transformedReq.url);
        const pathname = url.pathname;
        const target = `${svcTarget}${pathname}${url.search}`;
        // Build forwarded headers for queued requests as well
        const headers = new Headers(transformedReq.headers);
        const orig = new URL(req.url);
        headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));
        headers.set("x-forwarded-host", orig.host);
        headers.set(
          "x-forwarded-port",
          orig.port || (orig.protocol === "https:" ? "443" : "80"),
        );
        headers.set("x-forwarded-path", orig.pathname);
        headers.set("x-forwarded-query", orig.search.replace(/^\?/, ""));
        // Track inflight for queued requests to prevent premature idle shutdown
        manager.incrementServiceInflight(service);
        manager.markServiceActivity(service);
        const res = await fetch(target, {
          method: transformedReq.method,
          headers,
          body: transformedReq.body,
          redirect: "manual",
          duplex: "half",
        } as RequestInit);
        await effectiveStore.resolve<Response>(id,
          new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
        );
        manager.decrementServiceInflight(service);
        manager.markServiceActivity(service);
      } catch (e) {
        manager.decrementServiceInflight(service);
        manager.markServiceActivity(service);
        // Resolve with error response instead of rejecting —
        // waitFor callers get a clean Response either way
        await effectiveStore.resolve<Response>(id,
          new Response(
            JSON.stringify({ error: { message: (e as Error)?.message || "Proxy error" } }),
            {
              status: 502,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          ),
        );
      }
    }
  }

  async function enqueueAndWait(
    service: string,
    req: Request,
    maxItems: number,
    maxBodyBytes: number,
    maxWaitMs: number,
  ): Promise<Response> {
    // Capacity check via store counter
    const size = await effectiveStore.get<number>(`queue-size:${service}`) ?? 0;
    if (size >= maxItems) {
      return new Response(
        JSON.stringify({ error: { message: "Server busy" } }),
        {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    let body: ReadableStream<Uint8Array> | null = null;
    let cloned: Request;
    // Clone request with bounded body to avoid indefinite buffering
    try {
      const [b1, b2] = req.body ? req.body.tee() : [null, null] as unknown as [
        ReadableStream<Uint8Array> | null,
        ReadableStream<Uint8Array> | null,
      ];
      body = b1;
      const h = new Headers(req.headers);
      try {
        h.set("x-oxian-service", service);
      } catch { /* ignore */ }
      cloned = new Request(req, { body: b2 ?? undefined, headers: h });
    } catch {
      const h = new Headers(req.headers);
      try {
        h.set("x-oxian-service", service);
      } catch { /* ignore */ }
      cloned = new Request(req, { headers: h });
    }
    // For safety, consume up to maxBodyBytes if present
    if (body) {
      const reader = body.getReader();
      let received = 0;
      let buffered = 0;
      let exceededMaxBodyBytes = false;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > maxBodyBytes) {
              exceededMaxBodyBytes = true;
              break;
            }
            chunks.push(value);
            buffered += value.byteLength;
          }
        }
      } catch { /* ignore read errors */ }
      if (!exceededMaxBodyBytes) {
        const merged = new Uint8Array(buffered);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
        const h2 = new Headers(req.headers);
        try {
          h2.set("x-oxian-service", service);
        } catch { /* ignore */ }
        cloned = new Request(req, { body: merged, headers: h2 });
      }
    }

    // Enqueue via store and wait for response
    const id = await effectiveStore.enqueue<QueueItem>(`queue:${service}`, {
      req: cloned,
      enqueuedAt: Date.now(),
    });
    await effectiveStore.increment(`queue-size:${service}`);

    // Kick readiness wait; when ready, flush
    manager.waitForServiceReady(service, maxWaitMs).then(async (waited) => {
      if (waited) await flushQueue(service);
    }).catch(() => { /* ignore */ });

    // Block until flushQueue resolves this id, or timeout
    try {
      return await effectiveStore.waitFor<Response>(id, maxWaitMs);
    } catch {
      // waitFor timeout — return 503
      return new Response(
        JSON.stringify({ error: { message: "Queue wait timeout" } }),
        {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
  }

  // Dev autoreload: watch for file changes and trigger blue/green restarts
  const enableHotReload = config.runtime?.hotReload === true;
  if (enableHotReload) {
    try {
      const root = getLocalRootPath(config.root);
      const routesDir = config.routing?.routesDir ?? "routes";
      const watchDir = join(root, routesDir);
      const watcher = Deno.watchFs([watchDir], { recursive: true });
      console.log(`[hv] watching`, JSON.stringify({ dir: watchDir }));
      let timer: number | undefined;
      (async () => {
        for await (const _ev of watcher) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(async () => {
            console.log(`[hv] change detected, restarting workers`);
            const servicesToRestart = manager.listServices();
            for (const svc of servicesToRestart) {
              await manager.restartService(svc);
            }
          }, 120) as unknown as number;
        }
      })();
    } catch (e) {
      console.error(`[hv] watcher error`, { error: (e as Error)?.message });
    }
  }

  await server.finished;
  try {
    await otelProxyServer?.finished;
  } catch { /* ignore */ }
  try {
    manager.shutdown();
  } catch { /* ignore */ }
  // Stop all local workers
  if (plugin) {
    for (const [, handle] of manager.localHandles) {
      try {
        await plugin.stop(handle);
      } catch { /* ignore */ }
    }
  }
}

function findAvailablePort(startPort: number, maxTries = 50): number {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    try {
      const l = Deno.listen({ port });
      l.close();
      return port;
    } catch {
      // try next
    }
  }
  return startPort;
}


export function createLifecycleManager(
  opts: {
    config: EffectiveConfig;
    onServiceReady?: (service: string) => void | Promise<void>;
    plugin?: HypervisorPlugin;
    store: HypervisorStore;
  },
) {
  const { config, onServiceReady, store } = opts;
  const hv = config.runtime?.hv ?? {};
  const basePort = hv.workerBasePort ?? 9101;
  const PERF = config.logging?.performance === true;

  // ── Local-only state (not in store) ─────────────────────────────────
  // Process handles can't be serialized — they stay local
  const localHandles = new Map<string, unknown>();
  const serviceIndices = new Map<string, number>();
  const readyWaiters = new Map<string, Array<() => void>>();
  let cachedDenoOptions: string[] = [];
  let cachedScriptArgs: string[] = [];
  let idleCheckTimer: number | undefined;

  function setBaseArgs(denoOptions: string[], scriptArgs: string[]) {
    cachedDenoOptions = [...denoOptions];
    cachedScriptArgs = [...scriptArgs];
  }

  function notifyServiceReady(service: string) {
    const arr = readyWaiters.get(service) ?? [];
    for (const fn of arr) {
      try {
        fn();
      } catch { /* ignore */ }
    }
    readyWaiters.set(service, []);
  }

  async function waitForServiceReady(
    service: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (await store.get<boolean>(`ready:${service}`) === true) return true;
    return await new Promise<boolean>((resolve) => {
      const arr = readyWaiters.get(service) ?? [];
      let done = false;
      const t = setTimeout(() => {
        if (!done) {
          done = true;
          resolve(false);
        }
      }, Math.max(0, timeoutMs));
      arr.push(() => {
        if (!done) {
          done = true;
          clearTimeout(t);
          resolve(true);
        }
      });
      readyWaiters.set(service, arr);
    });
  }

  async function getTarget(service: string): Promise<string | undefined> {
    return await store.get<string>(`pool:${service}:target`);
  }

  function listServices(): string[] {
    return Array.from(localHandles.keys());
  }

  function getServiceIndex(service: string): number | undefined {
    return serviceIndices.get(service);
  }

  const hvLogger = { info: console.log, error: console.error } as const;

  function attachExitObserver(service: string, handle: unknown) {
    // Duck-type: if handle has .status, it's a ChildProcess
    const proc = handle as { status?: Promise<unknown> };
    if (!proc?.status) return;
    proc.status.then(async () => {
      const currentHandle = localHandles.get(service);
      if (currentHandle !== handle) return; // already swapped
      hvLogger.error(`[hv] worker exited`, { service });
      // Mark service down
      try {
        localHandles.delete(service);
        await store.delete(`pool:${service}:target`);
        await store.set(`ready:${service}`, false);
      } catch { /* ignore */ }
      const isIntentional = await store.get<boolean>(`intentionalStop:${service}`);
      if (isIntentional) {
        try {
          await store.delete(`intentionalStop:${service}`);
        } catch { /* ignore */ }
        return;
      }
      try {
        await restartService(service);
      } catch (e) {
        hvLogger.error(`[hv] auto-heal restart failed`, {
          service,
          err: (e as Error)?.message,
        });
      }
    }).catch(() => {/* ignore */});
  }

  async function spawnWorker(
    selected: ServiceDefinition,
    idx?: number,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
  ): Promise<void> {
    const svc = selected.service;

    // Guard against concurrent spawns via store lock
    const acquired = await store.acquire(`spawn:${svc}`, 300_000);
    if (!acquired) {
      // Another spawn in progress — wait for readiness
      await waitForServiceReady(svc, hv.proxy?.timeoutMs ?? 300_000);
      const target = await getTarget(svc);
      if (target) return;
      throw new Error(
        `Concurrent spawn detected but worker not available for service: ${svc}`,
      );
    }

    try {
      await doSpawnWorker(selected, idx, denoOptionsIn, scriptArgsIn);
    } finally {
      await store.release(`spawn:${svc}`);
    }
  }

  async function doSpawnWorker(
    selected: ServiceDefinition,
    idx?: number,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
  ): Promise<void> {
    const denoOptions = denoOptionsIn ?? cachedDenoOptions;
    const scriptArgs = scriptArgsIn ?? cachedScriptArgs;

    const t0 = performance.now();
    const port = findAvailablePort(basePort + (idx ?? 0));
    const svc = selected.service;
    const maxWaitMs = hv.proxy?.timeoutMs ?? 300_000;

    if (!opts.plugin) {
      throw new Error("[hv] plugin is required");
    }

    const pluginCtx: PluginContext = {
      config,
      resolver: createResolver(selected.source || config.root, {
        tokenEnv: "GITHUB_TOKEN",
        tokenValue: selected.auth?.github,
      }),
      denoOptions,
      scriptArgs,
    };

    const result = await opts.plugin.spawn(
      selected,
      pluginCtx,
      { port, idx: idx ?? 0 },
    );

    // Check readiness
    const ready = await opts.plugin.checkReady(result.target, {
      timeoutMs: maxWaitMs,
    });

    if (!ready) {
      hvLogger.error(`[hv] worker not ready`, {
        service: svc,
        target: result.target,
        waitedMs: maxWaitMs,
      });
      await store.set(`ready:${svc}`, false);
    } else {
      if (PERF) {
        hvLogger.info("[perf][hv] worker ready", {
          service: svc,
          target: result.target,
          ms: Math.round(performance.now() - t0),
        });
      } else hvLogger.info(`[hv] worker ready`, { service: svc, target: result.target });
      await store.set(`pool:${svc}:target`, result.target);
      await store.set(`ready:${svc}`, true);
      await store.set(`lastLoad:${svc}`, Date.now());
      await store.set(`activity:${svc}`, Date.now());
      localHandles.set(svc, result.handle);
      notifyServiceReady(svc);
      if (onServiceReady) await onServiceReady(svc);
    }

    await store.set(`config:${svc}`, selected);
    attachExitObserver(svc, result.handle);
  }

  function toMs(v: string | number | Date | undefined): number | undefined {
    if (v === undefined) return undefined;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const t = Date.parse(v);
      return Number.isNaN(t) ? undefined : t;
    }
    return undefined;
  }

  async function shouldRestartForCacheInvalidation(
    service: string,
    selected: ServiceDefinition,
  ): Promise<boolean> {
    const selectedAt = toMs(selected.invalidateCacheAt);
    if (selectedAt === undefined) return false;

    const lastSelected = await store.get<ServiceDefinition>(`config:${service}`);
    const lastSelectedAt = toMs(lastSelected?.invalidateCacheAt);
    if (lastSelectedAt !== undefined && lastSelectedAt === selectedAt) {
      return false;
    }

    const lastLoad = (await store.get<number>(`lastLoad:${service}`)) ?? 0;
    return selectedAt > lastLoad || lastSelectedAt !== selectedAt;
  }

  async function restartService(
    service: string,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
    basisIn?: ServiceDefinition,
  ) {
    const acquired = await store.acquire(`restart:${service}`, 300_000);
    if (!acquired) return;
    try {
      const idx = getServiceIndex(service) ?? 0;
      const lastOpts = await store.get<ServiceDefinition>(`config:${service}`);
      const basis = basisIn ?? lastOpts ?? { service } as ServiceDefinition;
      const oldHandle = localHandles.get(service);
      await spawnWorker(
        basis,
        idx,
        denoOptionsIn ?? cachedDenoOptions,
        scriptArgsIn ?? cachedScriptArgs,
      );
      // Stop old worker after new one is ready (blue/green)
      if (oldHandle && opts.plugin) {
        try {
          await opts.plugin.stop(oldHandle);
        } catch { /* ignore */ }
        console.log(`[hv] old worker terminated`, { service });
      }
    } finally {
      await store.release(`restart:${service}`);
    }
  }

  async function markServiceActivity(service: string) {
    await store.set(`activity:${service}`, Date.now());
  }

  async function incrementServiceInflight(service: string) {
    await store.increment(`inflight:${service}`);
  }

  async function decrementServiceInflight(service: string) {
    await store.decrement(`inflight:${service}`);
  }

  async function getIdleTtlForService(service: string): Promise<number | undefined> {
    const lastOpts = await store.get<ServiceDefinition>(`config:${service}`);
    const fromSpawn = lastOpts?.idleTtlMs;
    if (typeof fromSpawn === "number") return fromSpawn;
    const fromGlobal = config.runtime?.hv?.autoscale?.idleTtlMs;
    return typeof fromGlobal === "number" ? fromGlobal : undefined;
  }

  function startIdleChecker() {
    if (idleCheckTimer) return;
    idleCheckTimer = setInterval(async () => {
      const now = Date.now();
      for (const service of listServices()) {
        const inflight = (await store.get<number>(`inflight:${service}`)) ?? 0;
        if (inflight > 0) continue;
        const ttl = await getIdleTtlForService(service);
        if (ttl === undefined || ttl === 0) continue;
        const lastActive = (await store.get<number>(`activity:${service}`)) ??
          (await store.get<number>(`lastLoad:${service}`)) ?? 0;
        if (lastActive === 0) continue;
        if (now - lastActive > ttl) {
          try {
            const target = await getTarget(service);
            console.log(`[hv] idle timeout, stopping worker`, {
              service,
              target,
              idleMs: now - lastActive,
              ttlMs: ttl,
            });
            await store.set(`intentionalStop:${service}`, true);
            await store.delete(`pool:${service}:target`);
            await store.set(`ready:${service}`, false);
            const handle = localHandles.get(service);
            if (handle && opts.plugin) {
              try {
                await opts.plugin.stop(handle);
              } catch { /* ignore */ }
            }
            localHandles.delete(service);
          } catch (e) {
            console.error(`[hv] idle stop error`, {
              service,
              err: (e as Error)?.message,
            });
          }
        }
      }
    }, 1000) as unknown as number;
  }

  function shutdown() {
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = undefined;
    }
  }

  return {
    setBaseArgs,
    notifyServiceReady,
    waitForServiceReady,
    spawnWorker,
    restartService,
    shouldRestartForCacheInvalidation,
    getTarget,
    listServices,
    getServiceIndex,
    localHandles,
    markServiceActivity,
    incrementServiceInflight,
    decrementServiceInflight,
    startIdleChecker,
    shutdown,
  } as const;
}
