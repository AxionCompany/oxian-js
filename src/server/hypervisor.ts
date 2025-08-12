import type { EffectiveConfig } from "../config/types.ts";
import type { HvProvider, ProjectRuntime } from "./hv_types.ts";
import { createLoaderManager } from "../loader/index.ts";
import { importModule } from "../runtime/importer.ts";

type WorkerProc = { port: number; proc: Deno.ChildProcess | null; inflight: number; healthy: boolean; kind: "process" | "thread"; thread?: Worker };

async function startProcessWorker(port: number, baseArgs: string[], cfgPath?: string): Promise<WorkerProc> {
  const args = ["run", "-A", "cli.ts", `--port=${port}`, ...baseArgs.filter((a) => !a.startsWith("--port="))];
  if (cfgPath) args.push(`--config=${cfgPath}`);
  const proc = new Deno.Command("deno", { args, stdout: "null", stderr: "null" }).spawn();
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${port}/`, { method: "HEAD" }); if (r.ok || r.status >= 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, proc, inflight: 0, healthy: true, kind: "process" };
}

async function startThreadWorker(port: number, project: string, runtime: ProjectRuntime, config: EffectiveConfig, cfgPath?: string): Promise<WorkerProc> {
  const permissions = config.permissions ?? {};
  const worker = new Worker(new URL("./worker_runner.js", import.meta.url).href, {
    type: "module",
    deno: {
      namespace: true,
      permissions: {
        net: permissions.net ?? true,
        read: permissions.read ?? false,
        write: permissions.write ?? false,
        env: permissions.env ?? [],
        ffi: permissions.ffi ?? false,
        hrtime: permissions.hrtime ?? false,
      } as unknown as Deno.PermissionOptions,
    } as any,
  } as any);
  worker.postMessage({ port, project, cfgPath });
  // poll readiness
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${port}/`, { method: "HEAD" }); if (r.ok || r.status >= 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, proc: null, inflight: 0, healthy: true, kind: "thread", thread: worker };
}

function rrPicker<T>(arr: T[]) {
  let i = 0;
  return () => { const v = arr[i % arr.length]; i++; return v; };
}

export async function startHypervisor(config: EffectiveConfig, baseArgs: string[] = []) {
  const hv = config.runtime?.hv ?? {};
  const publicPort = config.server?.port ?? 8080;
  const basePort = hv.workerBasePort ?? 9100;
  const autoscale = hv.autoscale ?? {};
  const defaultWorkers = hv.workers === "auto" || hv.workers === undefined ? Math.max(1, (globalThis as any).navigator?.hardwareConcurrency || 1) : Math.max(1, Number(hv.workers));

  // Optional provider: support local/remote via loaders
  let provider: HvProvider | null = null;
  const providerArg = Deno.args.find((a) => a.startsWith("--provider="));
  if (providerArg) {
    let spec = providerArg.split("=")[1];
    if (spec?.startsWith("module:")) spec = spec.slice("module:".length);
    try {
      const lm = createLoaderManager(config.root ?? Deno.cwd(), config.loaders?.github?.tokenEnv);
      const url = lm.resolveUrl(spec);
      const mod = await importModule(url, lm.getLoaders(), 60_000, config.root ?? Deno.cwd());
      provider = (mod.default ?? mod) as HvProvider;
    } catch (e) {
      console.error("failed_to_load_provider", (e as Error)?.message);
    }
  }

  const projectPools = new Map<string, { pick: () => WorkerProc; workers: WorkerProc[]; rr: () => WorkerProc; lastScaleUp?: number; lastScaleDown?: number }>();

  async function ensurePool(project: string) {
    if (projectPools.has(project)) return projectPools.get(project)!;
    const workers: WorkerProc[] = [];

    // fetch project runtime (shallow) if provider supports
    let pr: ProjectRuntime = { name: project };
    if (provider?.getProjectConfig) {
      try { pr = { name: project, ...(await provider.getProjectConfig(project)) }; } catch {}
    }

    const desired = Math.max(autoscale.min ?? defaultWorkers, 1);
    for (let i = 0; i < desired; i++) {
      const port = basePort + (projectPools.size * 100) + i;
      const kind = pr.worker?.kind ?? "process";
      const cfgPath = pr.config && typeof pr.config === "object" ? await writeTempConfig(project, pr.config) : undefined;
      const w = kind === "thread"
        ? await startThreadWorker(port, project, pr, config, cfgPath)
        : await startProcessWorker(port, baseArgs, cfgPath);
      workers.push(w);
    }
    const rr = rrPicker(workers);
    const pool = { workers, rr, pick: () => rr(), lastScaleUp: 0, lastScaleDown: 0 };
    projectPools.set(project, pool);

    // health loop
    const healthPath = hv.health?.path ?? "/";
    const interval = hv.health?.intervalMs ?? 10000;
    const timeout = hv.health?.timeoutMs ?? 1000;
    (async () => {
      while (true) {
        for (let idx = 0; idx < workers.length; idx++) {
          const w = workers[idx];
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeout);
            const r = await fetch(`http://localhost:${w.port}${healthPath}`, { method: "HEAD", signal: ctrl.signal });
            clearTimeout(t);
            w.healthy = r.ok || r.status >= 200;
          } catch { w.healthy = false; }
          if (!w.healthy) {
            try { if (w.proc) { w.proc.kill(); await w.proc.output(); } else { w.thread?.terminate(); } } catch {}
            const port = basePort + (projectPools.size * 100) + idx;
            const kind = pr.worker?.kind ?? "process";
            const cfgPath = pr.config && typeof pr.config === "object" ? await writeTempConfig(project, pr.config) : undefined;
            const replaced = kind === "thread" ? await startThreadWorker(port, project, pr, config, cfgPath) : await startProcessWorker(port, baseArgs, cfgPath);
            workers[idx] = replaced;
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }
    })();

    return pool;
  }

  function chooseWorker(pool: { workers: WorkerProc[]; rr: () => WorkerProc }, req: Request): WorkerProc {
    const strategy = hv.strategy ?? "round_robin";
    if (strategy === "least_busy") {
      let best = pool.workers[0];
      for (const w of pool.workers) if (w.inflight < best.inflight) best = w;
      return best;
    }
    if (strategy === "sticky") {
      const hdr = hv.stickyHeader ?? "x-session-id";
      const key = req.headers.get(hdr) ?? "";
      if (key) {
        const idx = Math.abs(hashString(key)) % pool.workers.length;
        return pool.workers[idx];
      }
      return pool.rr();
    }
    return pool.rr();
  }

  async function scaleIfNeeded(project: string, pool: { workers: WorkerProc[]; rr: () => WorkerProc; lastScaleUp?: number; lastScaleDown?: number }) {
    if (!hv.autoscale?.enabled) return;
    const now = Date.now();
    const inflight = pool.workers.reduce((a, w) => a + w.inflight, 0);
    const avgInflight = inflight / Math.max(pool.workers.length, 1);
    const target = hv.autoscale?.targetInflightPerWorker ?? 16;
    const min = hv.autoscale?.min ?? 1;
    const max = hv.autoscale?.max ?? Math.max(1, (globalThis as any).navigator?.hardwareConcurrency || 1);

    if (avgInflight > target && pool.workers.length < max && (!pool.lastScaleUp || now - (pool.lastScaleUp ?? 0) > (hv.autoscale?.scaleUpCooldownMs ?? 5000))) {
      const idx = pool.workers.length;
      const port = basePort + (projectPools.size * 100) + idx;
      // Note: provider getProjectConfig was used at pool creation; we reuse the same settings for simplicity
      const w = await startProcessWorker(port, baseArgs);
      pool.workers.push(w);
      pool.lastScaleUp = now;
      return;
    }

    if (avgInflight <= Math.max(1, Math.floor(target / 2)) && pool.workers.length > min && (!pool.lastScaleDown || now - (pool.lastScaleDown ?? 0) > (hv.autoscale?.scaleDownCooldownMs ?? 10000))) {
      const removed = pool.workers.pop();
      if (removed) {
        try { if (removed.proc) { removed.proc.kill(); await removed.proc.output(); } else { removed.thread?.terminate(); } } catch {}
      }
      pool.lastScaleDown = now;
    }
  }

  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);
    // Admin endpoints
    if (url.pathname === "/_hv/metrics") {
      const metrics = Array.from(projectPools.entries()).map(([name, pool]) => ({ name, workers: pool.workers.length, inflight: pool.workers.reduce((a, w) => a + w.inflight, 0) }));
      return new Response(JSON.stringify({ metrics }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/_hv/status") {
      const status = Array.from(projectPools.entries()).map(([name, pool]) => ({ name, workers: pool.workers.map((w) => ({ port: w.port, healthy: w.healthy, inflight: w.inflight, kind: w.kind })) }));
      return new Response(JSON.stringify({ status }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/_hv/scaleUp" && url.searchParams.get("project")) {
      const project = url.searchParams.get("project")!;
      const pool = await ensurePool(project);
      const idx = pool.workers.length;
      const port = basePort + (projectPools.size * 100) + idx;
      const w = await startProcessWorker(port, baseArgs);
      pool.workers.push(w);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url.pathname === "/_hv/scaleDown" && url.searchParams.get("project")) {
      const project = url.searchParams.get("project")!;
      const pool = await ensurePool(project);
      const removed = pool.workers.pop();
      if (removed) { try { if (removed.proc) { removed.proc.kill(); await removed.proc.output(); } else { removed.thread?.terminate(); } } catch {} }
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json; charset=utf-8" } });
    }

    let project = "default";
    let stripPrefix: string | undefined;
    if (provider) {
      try {
        const pick = await provider.pickProject(req);
        project = pick.project;
        stripPrefix = (pick as any).stripPathPrefix;
      } catch {}
    }

    // Admission (optional)
    try { await provider?.admission?.(req, project); } catch (e) {
      const body = { error: { message: (e as Error)?.message || "Forbidden" } };
      return new Response(JSON.stringify(body), { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    const pool = await ensurePool(project);
    await scaleIfNeeded(project, pool);
    const w = chooseWorker(pool, req);

    const pathname = stripPrefix && url.pathname.startsWith(stripPrefix) ? url.pathname.slice(stripPrefix.length) || "/" : url.pathname;
    const target = `http://localhost:${w.port}${pathname}${url.search}`;

    const headers = new Headers(req.headers);
    if (hv.proxy?.passRequestId) {
      const hdr = config.logging?.requestIdHeader ?? "x-request-id";
      if (!headers.has(hdr)) headers.set(hdr, crypto.randomUUID());
    }
    const controller = new AbortController();
    const proxyTimeout = hv.proxy?.timeoutMs ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), proxyTimeout);
    w.inflight++;
    try {
      const res = await fetch(target, { method: req.method, headers, body: req.body, signal: controller.signal });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      const body = JSON.stringify({ error: { message: (e as Error).message || "Upstream error" } });
      return new Response(body, { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    } finally {
      w.inflight--;
      clearTimeout(timeoutId);
    }
  });

  // Graceful shutdown signal handling
  const sig = Deno.addSignalListener ? (Deno.addSignalListener as any) : null;
  if (sig) {
    for (const s of ["SIGINT", "SIGTERM"]) {
      try { (Deno as any).addSignalListener(s, async () => { await shutdownAll(); }); } catch {}
    }
  }

  await server.finished;
  await shutdownAll();

  async function shutdownAll() {
    for (const pool of projectPools.values()) {
      // drain: wait up to idleTtl for inflight to drop
      const deadline = Date.now() + (hv.autoscale?.idleTtlMs ?? 2000);
      while (pool.workers.some((w) => w.inflight > 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      for (const w of pool.workers) {
        try { if (w.proc) { w.proc.kill(); await w.proc.output(); } else { w.thread?.terminate(); } } catch {}
      }
    }
  }
}

async function writeTempConfig(project: string, cfg: Record<string, unknown>): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: `.oxian.${project}.json` });
  await Deno.writeTextFile(path, JSON.stringify(cfg));
  return path;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return h;
} 