import type { EffectiveConfig } from "../config/types.ts";
import { getLocalRootPath } from "../utils/root.ts";
import { join } from "@std/path";
import type { Resolver } from "../resolvers/types.ts";
import { createLifecycleManager, type SelectedProject } from "./lifecycle.ts";

function splitBaseArgs(baseArgs: string[]): { denoOptions: string[]; scriptArgs: string[] } {
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
export async function startHypervisor({ config, baseArgs }: { config: EffectiveConfig; baseArgs: string[] }, _resolver: Resolver) {
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
  const projects = hv.projects && Object.keys(hv.projects).length > 0 ? Object.keys(hv.projects) : [];
  const requestQueues = new Map<string, Array<{ req: Request; resolve: (res: Response) => void; reject: (err: unknown) => void; enqueuedAt: number; maxWaitMs: number; done?: boolean; timeoutId?: number }>>();
  const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);

  // Lifecycle manager centralizes worker pools and restarts
  const manager = createLifecycleManager({
    config,
    onProjectReady: async (project) => {
      try { await flushQueue(project); } catch { /* ignore */ }
    },
  });
  manager.setBaseArgs(denoOptions, scriptArgs);

  for (let idx = 0; idx < projects.length; idx++) {
    const project = projects[idx];
    manager.setProjectIndex(project, idx);
    const worker = await manager.spawnWorker({ project }, idx);
    manager.registerWorker(project, worker);
  }

  if (PERF) console.log('[perf][hv] public listening', { port: publicPort });
  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

    // Provider-based selection first (used for per-project web config as well)
    // Provider-based selection first
    let selected: SelectedProject = { project: "default" };
    try {
      if (typeof hv.provider === "function") {
        const out = await hv.provider({ req });
        if (out && typeof out.project === 'string') {
          selected = out;
        }
      } else if (hv.select && Array.isArray(hv.select)) {
        const rules = hv.select as HvSelectionRule[];
        for (const rule of rules) {
          if (rule.default) { selected = { project: rule.project }; continue; }
          const r = rule;
          let ok = true;
          if (r.when?.pathPrefix && !url.pathname.startsWith(r.when.pathPrefix)) ok = false;
          if (r.when?.method && req.method !== r.when.method) ok = false;
          if (r.when?.hostEquals && url.hostname !== r.when.hostEquals) ok = false;
          if (r.when?.hostPrefix && !url.hostname.startsWith(r.when.hostPrefix)) ok = false;
          if (r.when?.hostSuffix && !url.hostname.endsWith(r.when.hostSuffix)) ok = false;
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
          if (ok) { selected = { project: r.project }; break; }
        }
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: (e as Error)?.message || "Admission rejected" } }), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    // All requests are proxied to the selected worker; project-specific web handling occurs inside the worker server

    let pool = manager.getPool(selected.project);
    const queueCfg = hv.queue ?? {};
    if (!pool) {
      // On-demand spawn with captured overrides from provider (single call)
      try {
        const idx = manager.getProjectIndex(selected.project) ?? projects.length;
        const worker = await manager.spawnWorker(selected, idx);
        manager.registerWorker(selected.project, worker);
        pool = manager.getPool(selected.project)!;
      } catch (_e) {
        // fallback to queue/wait logic
      }
      // Always enqueue request while waiting for worker readiness
      return await enqueueAndWait(selected.project, req, queueCfg.maxItems ?? 100, queueCfg.maxBodyBytes ?? 1_048_576, queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000));
    }

    if (!pool) {
      const body = JSON.stringify({ error: { message: "No worker available" } });
      return new Response(body, { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const pathname = url.pathname;
    const target = `http://127.0.0.1:${pool.port}${pathname}${url.search}`;

    const headers = new Headers(req.headers);
    if (hv.proxy?.passRequestId) {
      const hdr = config.logging?.requestIdHeader ?? "x-request-id";
      if (!headers.has(hdr)) headers.set(hdr, crypto.randomUUID());
    }

    try {
      const p0 = performance.now();
      if (!PERF) console.log(`[hv] proxy`, { method: req.method, url: url.toString(), selected: selected.project, target });
      const abortTimeoutMs = hv.proxy?.timeoutMs ?? 30000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), abortTimeoutMs);
      const res = await fetch(target, { method: req.method, headers, body: req.body, signal: controller.signal });
      clearTimeout(timer);
      if (PERF) console.log('[perf][hv] proxy_res', { status: res.status, target, ms: Math.round(performance.now() - p0) });
      else console.log(`[hv] proxy_res`, { status: res.status, statusText: res.statusText, target });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      console.error(`[hv] proxy_err`, { target, err: (e as Error)?.message });
      // Auto-heal: restart target project and retry once or queue
      try {
        await manager.restartProject(selected.project);
      } catch { /* ignore */ }
      return await enqueueAndWait(selected.project, req, queueCfg.maxItems ?? 100, queueCfg.maxBodyBytes ?? 1_048_576, queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 300_000));
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
      const maxWait = (maxWaitMs ?? (hv.queue?.maxWaitMs ?? 2_000));
      if (now - enqueuedAt > maxWait) {
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        resolve(new Response(JSON.stringify({ error: { message: "Queue wait timeout" } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }));
        continue;
      }
      try {
        const url = new URL(req.url);
        const pathname = url.pathname;
        const target = `http://localhost:${pool.port}${pathname}${url.search}`;
        const res = await fetch(target, { method: req.method, headers: req.headers, body: req.body });
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        resolve(new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }));
      } catch (e) {
        item.done = true;
        if (item.timeoutId) clearTimeout(item.timeoutId as unknown as number);
        reject(e);
      }
    }
  }

  async function enqueueAndWait(project: string, req: Request, maxItems: number, maxBodyBytes: number, maxWaitMs: number): Promise<Response> {
    const q = requestQueues.get(project) ?? [];
    if (q.length >= maxItems) {
      return new Response(JSON.stringify({ error: { message: "Server busy" } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    let body: ReadableStream<Uint8Array> | null = null;
    let cloned: Request;
    // Clone request with bounded body to avoid indefinite buffering
    try {
      const [b1, b2] = req.body ? req.body.tee() : [null, null] as unknown as [ReadableStream<Uint8Array> | null, ReadableStream<Uint8Array> | null];
      body = b1;
      cloned = new Request(req, { body: b2 ?? undefined });
    } catch {
      cloned = new Request(req);
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
      for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
      cloned = new Request(req, { body: merged });
    }

    const resP = new Promise<Response>((resolve, reject) => {
      const item = { req: cloned, resolve, reject, enqueuedAt: Date.now(), maxWaitMs } as { req: Request; resolve: (res: Response) => void; reject: (err: unknown) => void; enqueuedAt: number; maxWaitMs: number; done?: boolean; timeoutId?: number };
      const to = setTimeout(() => {
        if (item.done) return;
        item.done = true;
        resolve(new Response(JSON.stringify({ error: { message: "Queue wait timeout" } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }));
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
  for (const { entry: p } of manager.getPoolsArray()) {
    try { p.proc.kill(); } catch (_e) { /* ignore kill error */ }
    try { await p.proc.status; } catch (_e) { /* ignore status error */ }
  }
} 