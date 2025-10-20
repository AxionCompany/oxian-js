import type { EffectiveConfig } from "../config/index.ts";
import denoJson from "../../deno.json" with { type: "json" };
import { createResolver } from "../resolvers/index.ts";
import type { SelectedProject, WorkerHandle } from "./types.ts";
import { getLocalRootPath } from "../utils/root.ts";
import { join } from "@std/path";
import type { Resolver } from "../resolvers/types.ts";

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
  _resolver: Resolver,
) {

  const hv = config.runtime?.hv ?? {};
  const publicPort = config.server?.port ?? 8080;
  const PERF = config.logging?.performance === true;

  type HvSelectionRule = {
    project: string;
    default?: boolean;
    when?: {
      pathPrefix?: string;
      hostEquals?: string;
      hostPrefix?: string;
      hostSuffix?: string;
      method?: string;
      header?: Record<string, string | RegExp>;
    };
  };

  // Determine projects from config (simplest: single default)
  const projects = hv.projects && Object.keys(hv.projects).length > 0
    ? Object.keys(hv.projects)
    : [];
  const requestQueues = new Map<
    string,
    Array<
      {
        req: Request;
        resolve: (res: Response) => void;
        reject: (err: unknown) => void;
        enqueuedAt: number;
        maxWaitMs: number;
        done?: boolean;
        timeoutId?: number;
      }
    >
  >();
  const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);

  // Lifecycle manager centralizes worker pools and restarts
  const manager = createLifecycleManager({
    config,
    onProjectReady: async (project) => {
      try {
        await flushQueue(project);
      } catch { /* ignore */ }
    },
  });
  manager.setBaseArgs(denoOptions, scriptArgs);

  for (let idx = 0; idx < projects.length; idx++) {
    const project = projects[idx];
    manager.setProjectIndex(project, idx);
    const worker = await manager.spawnWorker({ project }, idx);
    manager.registerWorker(project, worker);
  }

  const OTEL_OR_COLLECTOR = (config.logging?.otel?.enabled === true) ||
    (hv.otelCollector?.enabled === true) || (hv.otelProxy?.enabled === true);
  if (PERF) {
    console.log("[perf][hv] public listening", {
      project: "default",
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
      const ct = req.headers.get("content-type") || "";
      const hdrs: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      const projectFromHeader = req.headers.get("x-oxian-project") || undefined;
      let shouldForward = true;
      try {
        if (typeof onReq === "function") {
          // Pass a clone so the callback can safely read the body without consuming the original
          const reqForHook = req.clone();
          shouldForward = await onReq({
            kind,
            req: reqForHook,
            project: projectFromHeader,
            contentType: ct,
            headers: hdrs,
          });
        }
      } catch { /* ignore user callback errors; default to forward */ }
      if (!shouldForward || !upstream) {
        return new Response(null, { status: 202 });
      }
      const fwdUrl = upstream.replace(/\/$/, "") + trimmed;
      const fwdHeaders = new Headers(req.headers);
      try {
        if (projectFromHeader) fwdHeaders.set("x-oxian-project", projectFromHeader);
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
  console.log('public port', publicPort)
  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

    // Provider-based selection first (used for per-project web config as well)
    // Provider-based selection first
    let selected: SelectedProject = { project: "default" };
    try {
      if (typeof hv.provider === "function") {
        const out = await hv.provider({ req });
        if (out && typeof out.project === "string") {
          selected = out;
        }
      } else if (hv.select && Array.isArray(hv.select)) {
        const rules = hv.select as HvSelectionRule[];
        for (const rule of rules) {
          if (rule.default) {
            selected = { project: rule.project };
            continue;
          }
          const r = rule;
          let ok = true;
          if (
            r.when?.pathPrefix && !url.pathname.startsWith(r.when.pathPrefix)
          ) ok = false;
          if (r.when?.method && req.method !== r.when.method) ok = false;
          if (r.when?.hostEquals && url.hostname !== r.when.hostEquals) {
            ok = false;
          }
          if (
            r.when?.hostPrefix && !url.hostname.startsWith(r.when.hostPrefix)
          ) ok = false;
          if (r.when?.hostSuffix && !url.hostname.endsWith(r.when.hostSuffix)) {
            ok = false;
          }
          if (r.when?.header) {
            for (const [k, v] of Object.entries(r.when.header)) {
              const hvVal = req.headers.get(k);
              if (v instanceof RegExp) {
                if (!hvVal || !(v as RegExp).test(hvVal)) ok = false;
              } else {
                if (hvVal !== (v as string)) ok = false;
              }
            }
          }
          if (ok) {
            selected = { project: r.project };
            break;
          }
        }
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

    console.log("[hv] selected", selected);

    // All requests are proxied to the selected worker; project-specific web handling occurs inside the worker server

    let pool = manager.getPool(selected.project);
    const queueCfg = hv.queue ?? {};
    if (!pool) {
      // On-demand spawn with captured overrides from provider (single call)
      try {
        const idx = manager.getProjectIndex(selected.project) ??
          projects.length;
        const worker = await manager.spawnWorker(selected, idx);
        manager.registerWorker(selected.project, worker);
        pool = manager.getPool(selected.project)!;
      } catch (_e) {
        // fallback to queue/wait logic
      }
      // Always enqueue request while waiting for worker readiness
      return await enqueueAndWait(
        selected.project,
        req,
        queueCfg.maxItems ?? 100,
        queueCfg.maxBodyBytes ?? 1_048_576,
        queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000),
      );
    }

    if (!pool) {
      const body = JSON.stringify({
        error: { message: "No worker available" },
      });
      return new Response(body, {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const pathname = url.pathname;
    const target = `http://127.0.0.1:${pool.port}${pathname}${url.search}`;

    // Apply request transformation hook if provided
    let transformedReq = req;
    if (typeof hv.onRequest === "function") {
      try {
        transformedReq = await hv.onRequest({ req, project: selected.project });
      } catch (e) {
        console.error(`[hv] onRequest callback error`, {
          project: selected.project,
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

    const headers = new Headers(transformedReq.headers);
    // Preserve original client information for the worker
    const orig = new URL(req.url);
    headers.set("x-forwarded-proto", orig.protocol.replace(":", ""));
    headers.set("x-forwarded-host", orig.host);
    headers.set("x-forwarded-port", orig.port || (orig.protocol === "https:" ? "443" : "80"));
    headers.set("x-forwarded-path", orig.pathname);
    headers.set("x-forwarded-query", orig.search.replace(/^\?/, ""));
    if (hv.proxy?.passRequestId) {
      const hdr = config.logging?.requestIdHeader ?? "x-request-id";
      if (!headers.has(hdr)) headers.set(hdr, crypto.randomUUID());
    }
    // Always forward selected project to worker for logging/metrics
    try {
      headers.set("x-oxian-project", selected.project);
    } catch { /* ignore */ }

    try {
      const p0 = performance.now();
      if (!PERF && !OTEL_OR_COLLECTOR) {
        console.log(`[hv] proxy`, {
          project: selected.project,
          method: transformedReq.method,
          url: url.toString(),
          selected: selected.project,
          target,
        });
      }
      const abortTimeoutMs = hv.proxy?.timeoutMs ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), abortTimeoutMs);
      // Track inflight and activity for idle decisions. We consider request active until response body completes.
      manager.incrementInflight(selected.project);
      manager.markProjectActivity(selected.project);
      const res = await fetch(target, {
        method: transformedReq.method,
        headers,
        body: transformedReq.body,
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timer);
      if (PERF) {
        console.log("[perf][hv] proxy_res", {
          project: selected.project,
          status: res.status,
          target,
          ms: Math.round(performance.now() - p0),
        });
      } else if (!OTEL_OR_COLLECTOR) {
        console.log(`[hv] proxy_res`, {
          project: selected.project,
          status: res.status,
          statusText: res.statusText,
          target,
        });
      }
      const body = res.body;
      if (!body) {
        manager.decrementInflight(selected.project);
        manager.markProjectActivity(selected.project);
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
          manager.decrementInflight(selected.project);
          manager.markProjectActivity(selected.project);
        }
      })();
      return new Response(proxied, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } catch (e) {
      if (!OTEL_OR_COLLECTOR) {
        console.error(`[hv] proxy_err`, {
          project: selected.project,
          target,
          err: (e as Error)?.message,
        });
      }
      // Auto-heal: restart target project and retry once or queue
      try {
        await manager.restartProject(selected.project);
      } catch { /* ignore */ }
      return await enqueueAndWait(
        selected.project,
        req,
        queueCfg.maxItems ?? 100,
        queueCfg.maxBodyBytes ?? 1_048_576,
        queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000),
      );
    }
  });

  async function flushQueue(project: string) {
    const q = requestQueues.get(project);
    if (!q || q.length === 0) return;
    const pool = manager.getPool(project);
    if (!pool) return; // still not ready
    const items = q.splice(0, q.length);
    for (const item of items) {
      const { req, resolve, reject, enqueuedAt, maxWaitMs } = item;
      if (item.done) continue;
      const now = Date.now();
      const maxWait = maxWaitMs ?? (hv.queue?.maxWaitMs ?? 2_000);
      if (now - enqueuedAt > maxWait) {
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        resolve(
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
            transformedReq = await hv.onRequest({ req, project });
          } catch (_e) {
            item.done = true;
            if (item.timeoutId) {
              clearTimeout(item.timeoutId as unknown as number);
            }
            resolve(
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
        const target = `http://localhost:${pool.port}${pathname}${url.search}`;
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
        const res = await fetch(target, {
          method: transformedReq.method,
          headers,
          body: transformedReq.body,
          redirect: "manual",
        });
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        resolve(
          new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          }),
        );
      } catch (e) {
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        reject(e);
      }
    }
  }

  async function enqueueAndWait(
    project: string,
    req: Request,
    maxItems: number,
    maxBodyBytes: number,
    maxWaitMs: number,
  ): Promise<Response> {
    const q = requestQueues.get(project) ?? [];
    if (q.length >= maxItems) {
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
      // ensure project header is present on queued request
      const h = new Headers(req.headers);
      try {
        h.set("x-oxian-project", project);
      } catch { /* ignore */ }
      cloned = new Request(req, { body: b2 ?? undefined, headers: h });
    } catch {
      const h = new Headers(req.headers);
      try {
        h.set("x-oxian-project", project);
      } catch { /* ignore */ }
      cloned = new Request(req, { headers: h });
    }
    // For safety, consume up to maxBodyBytes if present
    if (body) {
      const reader = body.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            received += value.byteLength;
            if (received > maxBodyBytes) break;
            chunks.push(value);
          }
        }
      } catch { /* ignore read errors */ }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
      }
      const h2 = new Headers(req.headers);
      try {
        h2.set("x-oxian-project", project);
      } catch { /* ignore */ }
      cloned = new Request(req, { body: merged, headers: h2 });
    }

    const resP = new Promise<Response>((resolve, reject) => {
      const item = {
        req: cloned,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        maxWaitMs,
      } as {
        req: Request;
        resolve: (res: Response) => void;
        reject: (err: unknown) => void;
        enqueuedAt: number;
        maxWaitMs: number;
        done?: boolean;
        timeoutId?: number;
      };
      const to = setTimeout(() => {
        if (item.done) return;
        item.done = true;
        resolve(
          new Response(
            JSON.stringify({ error: { message: "Queue wait timeout" } }),
            {
              status: 503,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          ),
        );
      }, Math.max(0, maxWaitMs));
      item.timeoutId = to as unknown as number;
      q.push(item);
      requestQueues.set(project, q);
    });

    // kick a readiness wait; when ready, flush
    const waited = await manager.waitForProjectReady(project, maxWaitMs);
    if (waited) await flushQueue(project);
    return resP;
  }

  // Dev autoreload: watch for file changes and trigger blue/green restarts
  const enableHotReload = config.runtime?.hotReload === true;
  if (enableHotReload) {
    try {
      const root = getLocalRootPath(config.root);
      const routesDir = config.routing?.routesDir ?? "routes";
      const watchDir = join(root, routesDir);
      const watcher = Deno.watchFs([watchDir], { recursive: true });
      console.log(`[hv] watching`, { dir: watchDir });
      let timer: number | undefined;
      (async () => {
        for await (const _ev of watcher) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(async () => {
            console.log(`[hv] change detected, restarting workers`);
            const projectsToRestart = manager.listProjects();
            for (const project of projectsToRestart) {
              await manager.restartProject(project);
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
    await collectorServer?.finished;
  } catch { /* ignore */ }
  try {
    await otelProxyServer?.finished;
  } catch { /* ignore */ }
  try {
    manager.shutdown();
  } catch { /* ignore */ }
  for (const { entry: p } of manager.getPoolsArray()) {
    try {
      p.proc.kill();
    } catch (_e) { /* ignore kill error */ }
    try {
      await p.proc.status;
    } catch (_e) { /* ignore status error */ }
  }
}

type PoolEntry = {
  port: number;
  proc: Deno.ChildProcess;
  rr: () => WorkerHandle;
};

const ensureDir = (path: string) => {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch {
    // ignore
  }
};

function rrPicker<T>(arr: T[]) {
  let i = 0;
  return () => {
    const v = arr[i % Math.max(arr.length, 1)];
    i++;
    return v;
  };
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

async function detectHostDenoConfig(
  resolver: ReturnType<typeof createResolver>,
): Promise<string | undefined> {
  const candidates = ["deno.json", "deno.jsonc"];
  for (const name of candidates) {
    try {
      const resolved = await resolver.resolve(name);
      const { isFile } = await resolver.stat(resolved);
      if (isFile) return resolved.toString();
    } catch (_err) { /* no local deno config at this candidate */ }
  }
  return undefined;
}

export function createLifecycleManager(
  opts: {
    config: EffectiveConfig;
    onProjectReady?: (project: string) => void | Promise<void>;
  },
) {
  const { config, onProjectReady } = opts;
  const hv = config.runtime?.hv ?? {};
  const basePort = hv.workerBasePort ?? 9101;
  const PERF = config.logging?.performance === true;

  const pools = new Map<string, PoolEntry>();
  const projectIndices = new Map<string, number>();
  const readyWaiters = new Map<string, Array<() => void>>();
  const restarting = new Set<string>();
  const spawning = new Set<string>();
  const projectLastLoad = new Map<string, number>();
  const projectLastActive = new Map<string, number>();
  const projectReady = new Map<string, boolean>();
  const lastSpawnOptions = new Map<string, SelectedProject>();
  const projectInflight = new Map<string, number>();
  const intentionalStop = new Set<string>();
  let cachedDenoOptions: string[] = [];
  let cachedScriptArgs: string[] = [];
  let idleCheckTimer: number | undefined;

  function setBaseArgs(denoOptions: string[], scriptArgs: string[]) {
    cachedDenoOptions = [...denoOptions];
    cachedScriptArgs = [...scriptArgs];
  }

  function notifyProjectReady(project: string) {
    const arr = readyWaiters.get(project) ?? [];
    for (const fn of arr) {
      try {
        fn();
      } catch { /* ignore */ }
    }
    readyWaiters.set(project, []);
  }

  async function waitForProjectReady(
    project: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (projectReady.get(project) === true) return true;
    return await new Promise<boolean>((resolve) => {
      const arr = readyWaiters.get(project) ?? [];
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
      readyWaiters.set(project, arr);
    });
  }

  function registerWorker(project: string, handle: WorkerHandle) {
    pools.set(project, {
      port: handle.port,
      proc: handle.proc,
      rr: rrPicker([{ port: handle.port, proc: handle.proc }]),
    });
  }

  function getPool(project: string): PoolEntry | undefined {
    return pools.get(project);
  }

  function listProjects(): string[] {
    return Array.from(pools.keys());
  }

  function setProjectIndex(project: string, idx: number) {
    projectIndices.set(project, idx);
  }
  function getProjectIndex(project: string): number | undefined {
    return projectIndices.get(project);
  }

  const hvLogger = { info: console.log, error: console.error } as const;
  function attachExitObserver(project: string, proc: Deno.ChildProcess) {
    proc.status.then(async (_s) => {
      const current = pools.get(project);
      if (!current || current.proc !== proc) return; // already swapped
      hvLogger.error(`[hv] worker exited`, { project, port: current.port });
      // Mark project down and clear stale pool to avoid misrouting to reused ports
      try {
        pools.delete(project);
      } catch { /* ignore */ }
      projectReady.set(project, false);
      if (intentionalStop.has(project)) {
        // skip auto-restart when we intentionally stopped due to idle
        try {
          intentionalStop.delete(project);
        } catch { /* ignore */ }
        return;
      }
      try {
        await restartProject(project);
      } catch (e) {
        hvLogger.error(`[hv] auto-heal restart failed`, {
          project,
          err: (e as Error)?.message,
        });
      }
    }).catch(() => {/* ignore */ });
  }

  async function spawnWorker(
    selected: SelectedProject,
    idx?: number,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
  ): Promise<WorkerHandle> {
    const project = selected.project;

    // Guard against concurrent spawns for the same project
    if (spawning.has(project)) {
      // Wait for the ongoing spawn to complete
      await waitForProjectReady(project, hv.proxy?.timeoutMs ?? 300_000);
      const pool = pools.get(project);
      if (pool) {
        return { port: pool.port, proc: pool.proc };
      }
      throw new Error(
        `Concurrent spawn detected but worker not available for project: ${project}`,
      );
    }

    spawning.add(project);
    try {
      return await doSpawnWorker(selected, idx, denoOptionsIn, scriptArgsIn);
    } finally {
      spawning.delete(project);
    }
  }

  async function doSpawnWorker(
    selected: SelectedProject,
    idx?: number,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
  ): Promise<WorkerHandle> {
    const denoOptions = denoOptionsIn ?? cachedDenoOptions;
    const scriptArgs = scriptArgsIn ?? cachedScriptArgs;

    const t0 = performance.now();
    const port = await findAvailablePort(basePort + (idx ?? 0));

    // Merge provider-based spawn overrides if not already provided
    const selectedMerged: SelectedProject = { ...selected };
    // The provider is only invoked at request-routing time with { req } and its output
    // is passed down to spawnWorker via 'selected'. Avoid calling provider here with { project }
    // to keep the request as the single source of truth.

    const forceReload = denoOptions.some((arg) =>
      arg === "--reload" || arg === "-r" || arg.startsWith("--reload=")
    );

    const resolver = createResolver(selectedMerged.source || config.root, {
      tokenEnv: "GITHUB_TOKEN",
      tokenValue: selectedMerged.githubToken,
      forceReload,
    });

    const hostDenoCfg =
      (denoOptions.find((a) => a.startsWith("--deno-config="))?.split(
        "=",
      )[1]) ||
      hv.denoConfig ||
      await detectHostDenoConfig(resolver);

    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] hostDenoCfg", hostDenoCfg);
    }

    const project = selectedMerged.project;
    const denoArgs: string[] = ["run", ...denoOptions];

    const projectCfg = (hv.projects &&
      (hv.projects as Record<string, { denoConfig?: string }>)[project]) ||
      {} as { denoConfig?: string };
    const effectiveDenoCfg = projectCfg.denoConfig ?? hostDenoCfg;


    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] effectiveDenoCfg", effectiveDenoCfg);
    }

    if (!denoOptions.includes("--config") && effectiveDenoCfg) {
      let maybeHostDenoConfig: {
        imports?: Record<string, string>;
        scopes?: Record<string, Record<string, string>>;
      } = { imports: {}, scopes: {} };
      try {
        const resolved = await resolver.resolve(effectiveDenoCfg);
        const loaded = await resolver.load(resolved, { encoding: "utf-8" });
        const picked = JSON.parse(loaded as string);
        if (picked && typeof picked === "object") {
          maybeHostDenoConfig = picked as {
            imports?: Record<string, string>;
            scopes?: Record<string, Record<string, string>>;
          };
          if (Deno.env.get("OXIAN_DEBUG")) {
            console.log("[hv] maybeHostDenoConfig", maybeHostDenoConfig);
          }
        }
      } catch (e: unknown) {
        hvLogger.error(`[hv] error loading host deno config`, {
          error: (e as Error)?.message,
        });
      }
      const hostImports = (maybeHostDenoConfig?.imports) ?? {};
      const hostScopes = (maybeHostDenoConfig?.scopes) ?? {};
      const mergedImports: Record<string, string> = {
        ...(denoJson.imports || {}),
        ...hostImports,
      };
      const libSrcBase = new URL("../", import.meta.url);
      if (mergedImports["oxian-js/"]) {
        mergedImports["oxian-js/"] = libSrcBase.href;
      }
      for (const [specifier, url] of Object.entries(mergedImports)) {
        const isUrl = url.split(":").length > 1;
        if (!isUrl) {
          mergedImports[specifier] = (await resolver.resolve(url)).toString();
        }
      }
      if (Deno.env.get("OXIAN_DEBUG")) {
        console.log("[hv] mergedImports", mergedImports);
      }
      const mergedImportMap = {
        imports: mergedImports,
        scopes: {
          ...(((denoJson as unknown as {
            scopes?: Record<string, Record<string, string>>;
          })?.scopes) || {}),
          ...hostScopes,
        },
      } as {
        imports?: Record<string, string>;
        scopes?: Record<string, Record<string, string>>;
      };
      const jsonStr = JSON.stringify(mergedImportMap);
      const dataUrl = `data:application/json;base64,${btoa(jsonStr)}`;
      denoArgs.push(`--import-map=${dataUrl}`);
      // denoArgs.push(`--no-prompt`);

      if (Deno.env.get("OXIAN_DEBUG")) {
        console.log("[hv] import meta", import.meta.url);
      }

      // add deno unstable flags based on local deno.json
      denoJson.unstable?.forEach((flag) => {
        denoArgs.push(`--unstable-${flag}`);
      });

      // add deno permissions based on host deno.json, overridable with selected.permissions
      if (config.permissions || selected.permissions) {
        // add config.permissions - global permissions from global config
        config.permissions &&
          Object.entries(config.permissions).forEach(([key, value]) => {
            if (value !== false) {
              if (typeof value === "boolean" && value) {
                denoArgs.push(`--allow-${key}`);
              }
              if (typeof value === "string") {
                denoArgs.push(`--allow-${key}=${value}`);
              }
              if (typeof value === "object" && Array.isArray(value)) {
                denoArgs.push(`--allow-${key}=${value.join(",")}`);
              }
            } else {
              denoArgs.push(`--deny-${key}`);
            }
          });
        // override with selected.permissions - project-specific permissions
        selected.permissions &&
          Object.entries(selected.permissions).forEach(([key, value]) => {
            if (value !== false) {
              if (typeof value === "boolean" && value) {
                denoArgs.push(`--allow-${key}`);
              }
              if (typeof value === "string") {
                denoArgs.push(`--allow-${key}=${value}`);
              }
              if (typeof value === "object" && Array.isArray(value)) {
                denoArgs.push(`--allow-${key}=${value.join(",")}`);
              }
            } else {
              denoArgs.push(`--deny-${key}`);
            }
          });
      } else {
        denoArgs.push(`-A`);
      }
    }

    // Decide whether to use --reload based on invalidateCacheAt vs last load
    let shouldReload = false;
    if (selectedMerged.invalidateCacheAt !== undefined) {
      const last = projectLastLoad.get(project) ?? 0;
      let invalidateAt = 0;
      if (selectedMerged.invalidateCacheAt instanceof Date) {
        invalidateAt = selectedMerged.invalidateCacheAt.getTime();
      } else if (typeof selectedMerged.invalidateCacheAt === "number") {
        invalidateAt = selectedMerged.invalidateCacheAt;
      } else if (typeof selectedMerged.invalidateCacheAt === "string") {
        const t = Date.parse(selectedMerged.invalidateCacheAt);
        if (!Number.isNaN(t)) invalidateAt = t;
      }
      if (Deno.env.get("OXIAN_DEBUG")) {
        console.log(
          "[hv] invalidateAt",
          invalidateAt,
          "last",
          last,
          "shouldReload",
          invalidateAt > last,
        );
      }
      if (invalidateAt > last) shouldReload = true;
    } else {
      // use hotReload from config
      shouldReload = config.runtime?.hotReload === true;
    }
    if (shouldReload) {
      const reloadTargets: string[] = [];
      try {
        const rootResolved = await resolver.resolve("");
        if (rootResolved) reloadTargets.push(rootResolved.toString());
      } catch { /* ignore */ }
      if (selectedMerged.config) reloadTargets.push(selectedMerged.config);
      if (reloadTargets.length > 0) {
        const normalized: string[] = [];
        for (const t of reloadTargets) {
          const isUrl = t.split(":").length > 1;
          if (!isUrl) {
            try {
              normalized.push((await resolver.resolve(t)).toString());
            } catch {
              normalized.push(t);
            }
          } else normalized.push(t);
        }
        const value = normalized.join(",");
        denoArgs.push(`--reload=${value}`);
      }
    }

    denoArgs.push(`${import.meta.resolve("../../cli.ts")}`);

    const globalSource = Deno.args.find((a) => a.startsWith("--source="))
      ?.split("=")[1];
    const globalConfig = Deno.args.find((a) => a.startsWith("--config="))
      ?.split("=")[1];
    const projCfg = (hv.projects &&
      (hv.projects as Record<string, { source?: string; config?: string }>)[
      project
      ]) || {} as { source?: string; config?: string };
    const effectiveSource = selectedMerged.source ?? projCfg.source ??
      globalSource;
    const effectiveConfig = selectedMerged.config ?? projCfg.config ??
      globalConfig;

    // Determine project working directory early (needed for materialize step)

    async function hashString(inputString: string) {
      const encoder = new TextEncoder();
      const data = encoder.encode(inputString); // Encode the string to a Uint8Array

      const hashBuffer = await crypto.subtle.digest("SHA-256", data); // Hash the data

      // Convert ArrayBuffer to Array of bytes
      const hashArray = Array.from(new Uint8Array(hashBuffer));

      // Convert bytes to hex string
      const hashHex = hashArray.map((byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");

      return hashHex;
    }

    const projectHash = await hashString(project);

    const projectDir = selectedMerged.isolated
      ? `./.projects/${projectHash}`
      : Deno.cwd();
    if (selectedMerged.isolated) {
      ensureDir(`${projectDir}`);
    }

    // Two-step flow: perform materialize (and prepare) in a separate CLI invocation, then spawn worker without allow-run
    {
      const hvMat = (config.runtime?.hv as { materialize?: unknown })
        ?.materialize as boolean | {
          mode?: string;
          dir?: string;
          refresh?: boolean;
        } | undefined;
      const projMat = (config.runtime?.hv?.projects as
        | Record<
          string,
          {
            materialize?: boolean | {
              mode?: string;
              dir?: string;
              refresh?: boolean;
            };
          }
        >
        | undefined)?.[project]?.materialize;
      const selMat = selectedMerged.materialize;
      const mat = selMat ?? projMat ?? hvMat;
      const shouldMaterialize = !!(mat &&
        (typeof mat === "boolean"
          ? mat
          : (mat.mode === "always" || mat.mode === "auto")) &&
        effectiveSource);
      if (shouldMaterialize && effectiveSource) {
        const m = typeof mat === "boolean"
          ? { mode: "always" as const }
          : (mat as { mode?: string; dir?: string; refresh?: boolean });
        // const matDir = m.dir ? m.dir : (selectedMerged.isolated ? projectDir : projectDir);
        const matArgs: string[] = [
          ...denoArgs,
          "materialize",
          `--source=${effectiveSource}`,
          `--materialize-dir=.`,
          ...(m.refresh ? ["--materialize-refresh"] : []),
        ];

        const matCmd = new Deno.Command(Deno.execPath(), {
          args: matArgs,
          stdin: "null",
          stdout: "piped",
          stderr: "inherit",
          cwd: projectDir,
          env: {
            ...(selectedMerged.env || {}),
            ...(selectedMerged.githubToken
              ? { GITHUB_TOKEN: selectedMerged.githubToken }
              : {}),
          },
        });
        const out = await matCmd.output();
        if (!out.success) {
          throw new Error(
            `[hv] materialize step failed for project ${project}`,
          );
        }
        try {
          const text = new TextDecoder().decode(out.stdout);
          JSON.parse(text) as { ok?: boolean; rootDir?: string };
        } catch { /* ignore parse errors */ }
      }

      // Second step: run prepare (prepare hooks)
      const prepArgs: string[] = [
        ...denoArgs,
        "prepare",
      ];

      const prepCmd = new Deno.Command(Deno.execPath(), {
        args: prepArgs,
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
        cwd: projectDir,
        env: {
          ...(selectedMerged.env || {}),
          ...(selectedMerged.githubToken
            ? { GITHUB_TOKEN: selectedMerged.githubToken }
            : {}),
        },
      });
      const prepOut = await prepCmd.output();
      if (!prepOut.success) {
        throw new Error(`[hv] prepare step failed for project ${project}`);
      }
    }

    const finalScriptArgs = [
      `--port=${port}`,
      ...scriptArgs.filter((a) => !a.startsWith("--port=")),
      ...Deno.args.filter((a) =>
        !a.startsWith("--source=") && !a.startsWith("--config=") &&
        !a.startsWith("--hypervisor=")
      ),
      ...(effectiveSource && !selectedMerged.materialize
        ? [`--source=${effectiveSource}`]
        : []),
      ...(effectiveConfig ? [`--config=${effectiveConfig}`] : []),
    ];

    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] finalScriptArgs", finalScriptArgs);
    }

    const spawnEnv: Record<string, string> | undefined = {
      ...(selectedMerged.env || {}),
      ...(selectedMerged.githubToken
        ? { GITHUB_TOKEN: selectedMerged.githubToken }
        : {}),
    };
    // Propagate OpenTelemetry env for auto-instrumentation when configured
    try {
      const otelCfg = config.logging?.otel ??
        {} as {
          enabled?: boolean;
          serviceName?: string;
          endpoint?: string;
          protocol?: string;
          headers?: Record<string, string>;
          resourceAttributes?: Record<string, string>;
          propagators?: string;
          metricExportIntervalMs?: number;
        };
      if (otelCfg?.enabled || config.runtime?.hv?.otelProxy?.enabled) {
        spawnEnv.OTEL_DENO = "true";
        if (otelCfg.serviceName) {
          spawnEnv.OTEL_SERVICE_NAME = otelCfg.serviceName;
        }
        // Default to built-in collector or proxy if no endpoint is provided
        const builtInProxyPort = config.runtime?.hv?.otelProxy?.enabled
          ? (config.runtime?.hv?.otelProxy?.port ?? 4318)
          : undefined;

        if (builtInProxyPort) {
          spawnEnv.OTEL_EXPORTER_OTLP_ENDPOINT =
            `http://127.0.0.1:${builtInProxyPort}`;
        } else if (otelCfg.endpoint) {
          spawnEnv.OTEL_EXPORTER_OTLP_ENDPOINT = otelCfg.endpoint;
        }
        if (otelCfg.protocol) {
          spawnEnv.OTEL_EXPORTER_OTLP_PROTOCOL = otelCfg.protocol as string;
        }

        {
          const headerPairs: string[] = [];
          if (otelCfg.headers && Object.keys(otelCfg.headers).length) {
            for (const [k, v] of Object.entries(otelCfg.headers)) {
              headerPairs.push(`${k}=${v}`);
            }
          }
          // Always attach project so the built-in collector can tag payloads
          headerPairs.push(`x-oxian-project=${project}`);
          spawnEnv.OTEL_EXPORTER_OTLP_HEADERS = headerPairs.join(",");
        }
        // Merge resource attributes with project
        const baseAttrs: Record<string, string> = {
          ...(otelCfg.resourceAttributes || {}),
        };
        baseAttrs["oxian.project"] = project;
        const attrs = Object.entries(baseAttrs).map(([k, v]) => `${k}=${v}`)
          .join(",");
        if (attrs) spawnEnv.OTEL_RESOURCE_ATTRIBUTES = attrs;
        if (otelCfg.propagators) {
          spawnEnv.OTEL_PROPAGATORS = otelCfg.propagators;
        }
        if (typeof otelCfg.metricExportIntervalMs === "number") {
          spawnEnv.OTEL_METRIC_EXPORT_INTERVAL = String(
            otelCfg.metricExportIntervalMs,
          );
        }
      }
    } catch { /* ignore otel env config errors */ }
    spawnEnv.DENO_AUTH_TOKENS = `${spawnEnv.DENO_AUTH_TOKENS ? spawnEnv.DENO_AUTH_TOKENS + ";" : ""
      }${selectedMerged.githubToken
        ? `${selectedMerged.githubToken}@raw.githubusercontent.com`
        : ""
      }`;

    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] globalSource", globalSource);
      console.log("[hv] globalConfig", globalConfig);
    }

    if (selectedMerged.isolated) {
      spawnEnv.DENO_DIR = `./.deno/DENO_DIR`;
      const allowRead = finalScriptArgs.find((a) => a.startsWith("--allow-read="))?.split("=")[1] ?? "";
      const allowWrite = finalScriptArgs.find((a) => a.startsWith("--allow-write="))?.split("=")[1] ?? "";
      finalScriptArgs.push(`--allow-read=${allowRead ? allowRead + "/**/*" + `,${projectDir}/**/*` : `${projectDir}/**/*`}`);
      finalScriptArgs.push(`--allow-write=${allowWrite ? allowWrite + "/**/*" + `,${projectDir}/**/*` : `${projectDir}/**/*`}`);
    }


    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] projectDir", projectDir);
    }

    if (Deno.env.get("OXIAN_DEBUG")) {
      console.log("[hv] spawning worker final args", [
        ...denoArgs,
        ...finalScriptArgs,
      ]);
    }

    console.log("[hv] spawning env", spawnEnv);

    const proc = new Deno.Command(Deno.execPath(), {
      args: [...denoArgs, ...finalScriptArgs],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
      env: spawnEnv,
      cwd: projectDir,
    }).spawn();

    // Readiness wait
    {
      const maxWaitMs = hv.proxy?.timeoutMs ?? 300_000;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < maxWaitMs) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/_health`, {
            method: "HEAD",
            signal: AbortSignal.timeout(500),
          });
          if (r.ok || r.status >= 200) {
            ready = true;
            break;
          }
        } catch { /* ignore until ready */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) {
        hvLogger.error(`[hv] worker not ready`, {
          project,
          port,
          waitedMs: Date.now() - start,
        });
        projectReady.set(project, false);
      } else {
        if (PERF) {
          hvLogger.info("[perf][hv] worker ready", {
            project,
            port,
            ms: Math.round(performance.now() - t0),
          });
        } else hvLogger.info(`[hv] worker ready`, { project, port });
        projectReady.set(project, true);
        // mark last load time for reload decisions
        projectLastLoad.set(project, Date.now());
        // mark activity baseline
        projectLastActive.set(project, Date.now());
        // signal readiness to any waiters
        notifyProjectReady(project);
        if (onProjectReady) await onProjectReady(project);
      }
    }

    // Persist last spawn options for consistent restarts
    lastSpawnOptions.set(project, selectedMerged);

    attachExitObserver(selected.project, proc);
    return { port, proc };
  }

  async function restartProject(
    project: string,
    denoOptionsIn?: string[],
    scriptArgsIn?: string[],
  ) {
    if (restarting.has(project)) return;
    restarting.add(project);
    try {
      const idx = getProjectIndex(project) ?? 0;
      const basis = lastSpawnOptions.get(project) ??
        { project } as SelectedProject;
      const next = await spawnWorker(
        basis,
        idx,
        denoOptionsIn ?? cachedDenoOptions,
        scriptArgsIn ?? cachedScriptArgs,
      );
      const existing = pools.get(project);
      if (!existing) {
        pools.set(project, {
          port: next.port,
          proc: next.proc,
          rr: rrPicker([{ port: next.port, proc: next.proc }]),
        });
        // Readiness will be notified by spawnWorker when health passes
        return;
      }
      const oldProc = existing.proc;
      const oldPort = existing.port;
      existing.port = next.port;
      existing.proc = next.proc;
      existing.rr = rrPicker([{ port: next.port, proc: next.proc }]);
      pools.set(project, existing);
      // Readiness will be notified by spawnWorker when health passes
      try {
        oldProc.kill();
      } catch (_e) { /* ignore kill */ }
      console.log(`[hv] old worker terminated`, { project, oldPort });
    } finally {
      restarting.delete(project);
    }
  }

  async function ensureWorker(project: string): Promise<void> {
    if (pools.get(project)) return;
    await restartProject(project);
  }

  function getPoolsArray(): Array<{ project: string; entry: PoolEntry }> {
    return Array.from(pools.entries()).map(([project, entry]) => ({
      project,
      entry,
    }));
  }

  function markProjectActivity(project: string) {
    projectLastActive.set(project, Date.now());
  }

  function incrementInflight(project: string) {
    const current = projectInflight.get(project) ?? 0;
    projectInflight.set(project, current + 1);
  }

  function decrementInflight(project: string) {
    const current = projectInflight.get(project) ?? 0;
    const next = current - 1;
    projectInflight.set(project, next > 0 ? next : 0);
  }

  function getIdleTtlForProject(project: string): number | undefined {
    const fromSpawn = lastSpawnOptions.get(project)?.idleTtlMs;
    if (typeof fromSpawn === "number") return fromSpawn;
    const hvProjects = (config.runtime?.hv?.projects ?? {}) as Record<
      string,
      { idleTtlMs?: number }
    >;
    const fromProj = hvProjects?.[project]?.idleTtlMs;
    if (typeof fromProj === "number") return fromProj;
    const fromGlobal = config.runtime?.hv?.autoscale?.idleTtlMs;
    return typeof fromGlobal === "number" ? fromGlobal : undefined;
  }

  function startIdleChecker() {
    if (idleCheckTimer) return;
    idleCheckTimer = setInterval(() => {
      const now = Date.now();
      for (const { project, entry } of getPoolsArray()) {
        const inflight = projectInflight.get(project) ?? 0;
        if (inflight > 0) continue;
        const ttl = getIdleTtlForProject(project);
        if (ttl === undefined) continue;
        const lastActive = projectLastActive.get(project) ??
          projectLastLoad.get(project) ?? 0;
        if (lastActive === 0) continue;
        if (now - lastActive > ttl) {
          try {
            console.log(`[hv] idle timeout, stopping worker`, {
              project,
              port: entry.port,
              idleMs: now - lastActive,
              ttlMs: ttl,
            });
            intentionalStop.add(project);
            pools.delete(project);
            projectReady.set(project, false);
            const p = entry.proc;
            try {
              p.kill();
            } catch { /* ignore */ }
          } catch (e) {
            console.error(`[hv] idle stop error`, {
              project,
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
    notifyProjectReady,
    waitForProjectReady,
    spawnWorker,
    restartProject,
    registerWorker,
    getPool,
    isProjectReady: (project: string) => projectReady.get(project) === true,
    listProjects,
    setProjectIndex,
    getProjectIndex,
    ensureWorker,
    getPoolsArray,
    markProjectActivity,
    incrementInflight,
    decrementInflight,
    startIdleChecker,
    shutdown,
  } as const;
}
