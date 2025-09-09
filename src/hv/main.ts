import type { EffectiveConfig } from "../config/types.ts";
import denoJson from "../../deno.json" with { type: "json" };
import { getLocalRootPath } from "../utils/root.ts";
import { isAbsolute, toFileUrl, join, fromFileUrl } from "@std/path";
import { parse as parseJsonc } from "@std/jsonc/parse";

const ensureDir = (path: string) => {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch {
    // ignore
  }
};

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

async function detectHostDenoConfig(root: string): Promise<string | undefined> {
  const candidates = ["deno.json", "deno.jsonc"];
  for (const name of candidates) {
    try {
      const p = `${root.endsWith("/") ? root.slice(0, -1) : root}/${name}`;
      await Deno.stat(p);
      return p;
    } catch (_err) { /* no local deno config at this candidate */ }
  }
  return undefined;
}

function rrPicker<T>(arr: T[]) {
  let i = 0;
  return () => { const v = arr[i % Math.max(arr.length, 1)]; i++; return v; };
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

export async function startHypervisor(config: EffectiveConfig, baseArgs: string[] = []) {
  const hv = config.runtime?.hv ?? {};
  const publicPort = config.server?.port ?? 8080;
  const basePort = hv.workerBasePort ?? 9101;
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

  type SelectedProject = {
    project: string;
    source?: string;
    config?: string;
    env?: Record<string, string>;
    githubToken?: string;
    stripPathPrefix?: string;
    isolated?: boolean;
  };

  // Determine projects from config (simplest: single default)
  const projects = hv.projects && Object.keys(hv.projects).length > 0 ? Object.keys(hv.projects) : [];

  const pools = new Map<string, { port: number; proc: Deno.ChildProcess; rr: () => { port: number; proc: Deno.ChildProcess }; next?: { port: number; proc: Deno.ChildProcess } }>();
  const projectIndices = new Map<string, number>();
  const readyWaiters = new Map<string, Array<() => void>>();
  const requestQueues = new Map<string, Array<{ req: Request; resolve: (res: Response) => void; reject: (err: unknown) => void; enqueuedAt: number }>>();

  function notifyProjectReady(project: string) {
    const arr = readyWaiters.get(project) ?? [];
    for (const fn of arr) {
      try { fn(); } catch { /* ignore */ }
    }
    readyWaiters.set(project, []);
  }

  async function waitForProjectReady(project: string, timeoutMs: number): Promise<boolean> {
    if (pools.get(project)) return true;
    return await new Promise<boolean>((resolve) => {
      const arr = readyWaiters.get(project) ?? [];
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, Math.max(0, timeoutMs));
      arr.push(() => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
      readyWaiters.set(project, arr);
    });
  }

  async function spawnWorker(selected: SelectedProject, idx: number, denoOptions: string[], scriptArgs: string[], hostDenoCfg?: string) {
    const t0 = performance.now();
    const port = await findAvailablePort(basePort + idx);
    const project = selected.project;
    const denoArgs: string[] = ["run", "-A", ...denoOptions];
    // Prefer per-project Deno config if specified
    const projectCfg = (hv.projects && (hv.projects as Record<string, { denoConfig?: string }>)[project]) || {} as { denoConfig?: string };
    const effectiveDenoCfg = projectCfg.denoConfig ?? hostDenoCfg;
    if (!denoOptions.includes("--config") && effectiveDenoCfg) {
      let maybeHostDenoConfig = { imports: {}, scopes: {} } as Record<string, unknown>;
      try {
        // Robust read: files (including Windows paths), file URLs, or http(s)
        const readJson = async (input: string): Promise<Record<string, unknown>> => {
          try {
            const u = new URL(input);
            if (u.protocol === "file:") {
              const text = await Deno.readTextFile(fromFileUrl(u));
              const isJsonc = u.pathname.endsWith(".jsonc");
              return isJsonc ? (parseJsonc(text) as Record<string, unknown>) : (JSON.parse(text) as Record<string, unknown>);
            }
            if (u.protocol === "http:" || u.protocol === "https:") {
              const res = await fetch(u);
              const text = await res.text();
              return JSON.parse(text) as Record<string, unknown>;
            }
            // Fallback to dynamic import for other schemes
            return (await import(u.toString(), { with: { type: "json" } })).default as Record<string, unknown>;
          } catch {
            const abs = isAbsolute(input) ? input : join(Deno.cwd(), input);
            const text = await Deno.readTextFile(abs);
            const isJsonc = abs.endsWith(".jsonc");
            return isJsonc ? (parseJsonc(text) as Record<string, unknown>) : (JSON.parse(text) as Record<string, unknown>);
          }
        };
        maybeHostDenoConfig = await readJson(effectiveDenoCfg);
      } catch (e: unknown) {
        console.error(`[hv] error loading host deno config`, { error: (e as Error)?.message });
      }
      const hostImports = ((maybeHostDenoConfig as { imports?: Record<string, string> })?.imports) ?? {};
      const hostScopes = ((maybeHostDenoConfig as { scopes?: Record<string, Record<string, string>> })?.scopes) ?? {};
      // Merge imports and rewrite relative addresses to absolute URLs so they are valid under data: import-map
      const mergedImports: Record<string, string> = {
        ...(denoJson.imports || {}),
        ...hostImports,
      };

      // Map GitHub "source" (from selection) to raw base for dynamic imports via import map
      try {
        const src = selected.source;
        if (src) {
          const su = new URL(src);
          if (su.protocol === "github:") {
            const parts = su.pathname.replace(/^\/+/, "").split("/");
            const owner = parts[0] ?? "";
            const repo = parts[1] ?? "";
            const rest = parts.slice(2).join("/");
            const ref = su.searchParams.get("ref") ?? "main";
            const normRest = rest ? (rest.endsWith("/") ? rest : rest + "/") : "";
            const githubBase = `@github/${owner}/${repo}/${normRest}`;
            const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${normRest}`;
            mergedImports[githubBase] = rawBase;
          } else if (su.protocol === "https:" && su.hostname === "github.com") {
            const p = su.pathname.replace(/^\/+/, "").split("/");
            const owner = p[0] ?? "";
            const repo = p[1] ?? "";
            const type = p[2];
            const ref = p[3] ?? "main";
            const rest = p.slice(type ? 4 : 2).join("/");
            const normRest = rest ? (rest.endsWith("/") ? rest : rest + "/") : "";
            const githubBase = `@github/${owner}/${repo}/${normRest}`;
            const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${normRest}`;
            mergedImports[githubBase] = rawBase;
          }
        }
      } catch { /* ignore malformed source */ }

      const libSrcBase = new URL("../", import.meta.url); // file:///.../src/
      const effectiveCfgUrl = effectiveDenoCfg ? new URL(effectiveDenoCfg) : undefined;
      const isUrlLike = (s: string) => {
        if (s.startsWith("jsr:") || s.startsWith("npm:") || s.startsWith("node:") || s.startsWith("deno:") || s.startsWith("data:")) return true;
        try { new URL(s); return true; } catch { return false; }
      };
      const absolutize = (val: string, base?: URL): string => {
        if (isUrlLike(val)) return val;
        try { return new URL(val, base ?? libSrcBase).href; } catch { return val; }
      };

      // Rewrite known library mapping and host-relative mappings
      if (mergedImports["oxian-js/"]) {
        mergedImports["oxian-js/"] = libSrcBase.href;
      }
      for (const [k, v] of Object.entries(mergedImports)) {
        // Skip if already URL-like
        if (isUrlLike(v)) continue;
        // Prefer resolving host entries relative to host deno config; fallback to lib base
        mergedImports[k] = absolutize(v, effectiveCfgUrl ?? libSrcBase);
      }

      const mergedImportMap = {
        imports: mergedImports,
        scopes: {
          ...(((denoJson as unknown as { scopes?: Record<string, Record<string, string>> })?.scopes) || {}),
          ...hostScopes,
        },
      } as { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> };
      const jsonStr = JSON.stringify(mergedImportMap);
      const dataUrl = `data:application/json;base64,${btoa(jsonStr)}`;
      denoArgs.push(`--import-map=${dataUrl}`);
    }

    denoArgs.push(`${import.meta.resolve('../../cli.ts')}`);
    // Build per-project source/config forwarding (project settings + provider overrides + global fallback)
    const globalSource = Deno.args.find((a) => a.startsWith("--source="))?.split("=")[1];
    const globalConfig = Deno.args.find((a) => a.startsWith("--config="))?.split("=")[1];
    const projCfg = (hv.projects && (hv.projects as Record<string, { source?: string; config?: string }>)[project]) || {} as { source?: string; config?: string };
    const effectiveSource = selected.source ?? projCfg.source ?? globalSource;
    const effectiveConfig = selected.config ?? projCfg.config ?? globalConfig;

    const finalScriptArgs = [
      `--port=${port}`,
      ...scriptArgs.filter((a) => !a.startsWith("--port=")),
      // Filter out any global --source/--config to avoid duplication; re-add below
      ...Deno.args.filter((a) => !a.startsWith("--source=") && !a.startsWith("--config=") && !a.startsWith("--hypervisor=")),
      ...(effectiveSource ? [`--source=${effectiveSource}`] : []),
      ...(effectiveConfig ? [`--config=${effectiveConfig}`] : []),
    ];
    // Propagate per-project env if provided by provider (including github token)
    const spawnEnv: Record<string, string> | undefined = { ...(selected.env || {}), ...(selected.githubToken ? { GITHUB_TOKEN: selected.githubToken } : {}) };
    spawnEnv.DENO_AUTH_TOKENS = `${spawnEnv.DENO_AUTH_TOKENS ? spawnEnv.DENO_AUTH_TOKENS + ";" : ""}${selected.githubToken ? `${selected.githubToken}@raw.githubusercontent.com` : ""}`;
    
    const projectDir = selected.isolated ? `./deno/${project}` : Deno.cwd();

    if (selected.isolated) {
      // set isolated deno dir
      ensureDir(`${projectDir}`);
      spawnEnv.DENO_DIR = `./DENO_DIR`;
      // allow read and write to projectDir/**/*
      finalScriptArgs.push(`--allow-read=${projectDir + "/**/*"}`);
      finalScriptArgs.push(`--allow-write=${projectDir + "/**/*"}`);

    }
    console.log(`[hv] spawnEnv DENO_AUTH_TOKENS`, spawnEnv.DENO_AUTH_TOKENS);

    const proc = new Deno.Command(Deno.execPath(), {
      args: [...denoArgs, ...finalScriptArgs],
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
      env: spawnEnv,
      cwd: projectDir,
    }).spawn();

    {
      const maxWaitMs = hv.proxy?.timeoutMs ?? 60_000;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < maxWaitMs) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/_health`, { method: "HEAD", signal: AbortSignal.timeout(500) });
          if (r.ok || r.status >= 200) { ready = true; break; }
        } catch { /* ignore until ready */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) console.error(`[hv] worker not ready`, { project, port, waitedMs: Date.now() - start });
      else {
        if (PERF) console.log('[perf][hv] worker ready', { project, port, ms: Math.round(performance.now() - t0) });
        else console.log(`[hv] worker ready`, { project, port });
      }
    }

    return { port, proc } as { port: number; proc: Deno.ChildProcess };
  }

  async function restartProject(project: string, denoOptions: string[], scriptArgs: string[], hostDenoCfg?: string) {
    const idx = projectIndices.get(project) ?? 0;
    console.log(`[hv] restart requested`, { project });
    const next = await spawnWorker({ project }, idx, denoOptions, scriptArgs, hostDenoCfg);
    const existing = pools.get(project);
    if (!existing) {
      pools.set(project, { port: next.port, proc: next.proc, rr: rrPicker([{ port: next.port, proc: next.proc }]) });
      notifyProjectReady(project);
      return;
    }
    // Blue/green: switch to new, then kill old
    const oldProc = existing.proc;
    const oldPort = existing.port;
    existing.port = next.port;
    existing.proc = next.proc;
    existing.rr = rrPicker([{ port: next.port, proc: next.proc }]);
    pools.set(project, existing);
    notifyProjectReady(project);
    // Flush any queued requests for this project
    await flushQueue(project).catch(() => { });
    try { oldProc.kill(); } catch (_e) { /* ignore kill */ }
    console.log(`[hv] old worker terminated`, { project, oldPort });
  }

  // Determine deno config to forward
  let hostDenoCfg = (Deno.args.find((a) => a.startsWith("--deno-config="))?.split("=")[1])
    || hv.denoConfig
    || await detectHostDenoConfig(getLocalRootPath(config.root));

  if (hostDenoCfg) {
    // Normalize to URL string; support Windows drive-letter paths
    try {
      const u = new URL(hostDenoCfg);
      hostDenoCfg = u.toString();
    } catch {
      const path = isAbsolute(hostDenoCfg) ? hostDenoCfg : join(Deno.cwd(), hostDenoCfg);
      try {
        hostDenoCfg = toFileUrl(path).toString();
      } catch {
        // Fallback: manually construct file URL for Windows-like paths
        const normalized = path.replace(/\\/g, "/");
        hostDenoCfg = normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
      }
    }
  }

  const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);

  for (let idx = 0; idx < projects.length; idx++) {
    const project = projects[idx];
    projectIndices.set(project, idx);
    const worker = await spawnWorker({ project }, idx, denoOptions, scriptArgs, hostDenoCfg);
    pools.set(project, { port: worker.port, proc: worker.proc, rr: rrPicker([{ port: worker.port, proc: worker.proc }]) });
  }

  if (PERF) console.log('[perf][hv] public listening', { port: publicPort });
  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

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

    let pool = pools.get(selected.project) ?? pools.get("default")!;
    const queueCfg = hv.queue ?? {};
    const queueEnabled = queueCfg.enabled !== false;
    if (!pool) {
      // On-demand spawn with captured overrides from provider (single call)
      try {
        const idx = projectIndices.get(selected.project) ?? projects.length;
        const worker = await spawnWorker(selected, idx, denoOptions, scriptArgs, hostDenoCfg);
        pools.set(selected.project, { port: worker.port, proc: worker.proc, rr: rrPicker([{ port: worker.port, proc: worker.proc }]) });
        pool = pools.get(selected.project)!;
      } catch (_e) {
        // fallback to queue/wait logic
      }
      // Enqueue request optionally while waiting for worker readiness
      if (queueEnabled) {
        return await enqueueAndWait(selected.project, req, queueCfg.maxItems ?? 100, queueCfg.maxBodyBytes ?? 1_048_576, queueCfg.maxWaitMs ?? (hv.proxy?.timeoutMs ?? 2_000));
      } else {
        const waited = await waitForProjectReady(selected.project, hv.proxy?.timeoutMs ?? 2_000);
        if (!waited) {
          const body = JSON.stringify({ error: { message: "No worker available" } });
          return new Response(body, { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
        }
        pool = pools.get(selected.project) ?? pools.get("default")!;
      }
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
      const body = JSON.stringify({ error: { message: (e as Error).message || "Upstream error" } });
      return new Response(body, { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  });

  async function flushQueue(project: string) {
    const q = requestQueues.get(project);
    if (!q || q.length === 0) return;
    const pool = pools.get(project);
    if (!pool) return; // still not ready
    const items = q.splice(0, q.length);
    for (const item of items) {
      const { req, resolve, reject, enqueuedAt } = item;
      const now = Date.now();
      const maxWait = (hv.queue?.maxWaitMs ?? 2_000);
      if (now - enqueuedAt > maxWait) {
        resolve(new Response(JSON.stringify({ error: { message: "Queue wait timeout" } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }));
        continue;
      }
      try {
        const url = new URL(req.url);
        const pathname = url.pathname;
        const target = `http://localhost:${pool.port}${pathname}${url.search}`;
        const res = await fetch(target, { method: req.method, headers: req.headers, body: req.body });
        resolve(new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers }));
      } catch (e) {
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
      q.push({ req: cloned, resolve, reject, enqueuedAt: Date.now() });
      requestQueues.set(project, q);
    });

    // kick a readiness wait; when ready, flush
    const waited = await waitForProjectReady(project, maxWaitMs);
    if (waited) await flushQueue(project);
    return resP;
  }

  // Dev autoreload: watch for file changes and trigger blue/green restarts
  const enableHotReload = config.runtime?.hotReload !== false;
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
            for (const p of projects) {
              await restartProject(p, denoOptions, scriptArgs, hostDenoCfg);
            }
          }, 120) as unknown as number;
        }
      })();
    } catch (e) {
      console.error(`[hv] watcher error`, { error: (e as Error)?.message });
    }
  }

  await server.finished;
  for (const p of pools.values()) {
    try { p.proc.kill(); } catch (_e) { /* ignore kill error */ }
    try { await p.proc.status; } catch (_e) { /* ignore status error */ }
  }
} 