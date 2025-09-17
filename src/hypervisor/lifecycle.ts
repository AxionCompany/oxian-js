import type { EffectiveConfig } from "../config/types.ts";
import denoJson from "../../deno.json" with { type: "json" };
import { createResolver } from "../resolvers/index.ts";

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

export type SelectedProject = {
  project: string;
  source?: string;
  config?: string;
  env?: Record<string, string>;
  githubToken?: string;
  stripPathPrefix?: string;
  isolated?: boolean;
  // When provided, compares against last worker load time to decide if --reload should be used
  // Accepts ISO date string, epoch milliseconds, or Date
  invalidateCacheAt?: string | number | Date;
};

export type WorkerHandle = { port: number; proc: Deno.ChildProcess };

type PoolEntry = { port: number; proc: Deno.ChildProcess; rr: () => WorkerHandle };

const ensureDir = (path: string) => {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch {
    // ignore
  }
};

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

async function detectHostDenoConfig(resolver: ReturnType<typeof createResolver>): Promise<string | undefined> {
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

export function createLifecycleManager(opts: { config: EffectiveConfig; onProjectReady?: (project: string) => void | Promise<void> }) {
  const { config, onProjectReady } = opts;
  const hv = config.runtime?.hv ?? {};
  const basePort = hv.workerBasePort ?? 9101;
  const PERF = config.logging?.performance === true;

  const pools = new Map<string, PoolEntry>();
  const projectIndices = new Map<string, number>();
  const readyWaiters = new Map<string, Array<() => void>>();
  const restarting = new Set<string>();
  const projectLastLoad = new Map<string, number>();
  let cachedDenoOptions: string[] = [];
  let cachedScriptArgs: string[] = [];

  function setBaseArgs(denoOptions: string[], scriptArgs: string[]) {
    cachedDenoOptions = [...denoOptions];
    cachedScriptArgs = [...scriptArgs];
  }

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

  function registerWorker(project: string, handle: WorkerHandle) {
    pools.set(project, { port: handle.port, proc: handle.proc, rr: rrPicker([{ port: handle.port, proc: handle.proc }]) });
  }

  function getPool(project: string): PoolEntry | undefined {
    return pools.get(project);
  }

  function listProjects(): string[] { return Array.from(pools.keys()); }

  function setProjectIndex(project: string, idx: number) { projectIndices.set(project, idx); }
  function getProjectIndex(project: string): number { return projectIndices.get(project) ?? 0; }

  function attachExitObserver(project: string, proc: Deno.ChildProcess) {
    proc.status.then(async (_s) => {
      const current = pools.get(project);
      if (!current || current.proc !== proc) return; // already swapped
      console.error(`[hv] worker exited`, { project, port: current.port });
      try {
        await restartProject(project);
      } catch (e) {
        console.error(`[hv] auto-heal restart failed`, { project, err: (e as Error)?.message });
      }
    }).catch(() => { /* ignore */ });
  }

  async function spawnWorker(selected: SelectedProject, idx?: number, denoOptionsIn?: string[], scriptArgsIn?: string[]): Promise<WorkerHandle> {
    const denoOptions = denoOptionsIn ?? cachedDenoOptions;
    const scriptArgs = scriptArgsIn ?? cachedScriptArgs;

    const t0 = performance.now();
    const port = await findAvailablePort(basePort + (idx ?? 0));

    const resolver = createResolver(selected.source || config.root, { tokenEnv: "GITHUB_TOKEN", tokenValue: selected.githubToken });

    const hostDenoCfg = (denoOptions.find((a) => a.startsWith("--deno-config="))?.split("=")[1])
      || hv.denoConfig
      || await detectHostDenoConfig(resolver);

    const project = selected.project;
    const denoArgs: string[] = ["run", "-A", ...denoOptions];

    const projectCfg = (hv.projects && (hv.projects as Record<string, { denoConfig?: string }>)[project]) || {} as { denoConfig?: string };
    const effectiveDenoCfg = projectCfg.denoConfig ?? hostDenoCfg;
    if (!denoOptions.includes("--config") && effectiveDenoCfg) {
      let maybeHostDenoConfig: { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> } = { imports: {}, scopes: {} };
      try {
        const resolved = await resolver.resolve(effectiveDenoCfg);
        const loaded = await resolver.load(resolved);
        const picked = JSON.parse(loaded);
        if (picked && typeof picked === "object") {
          maybeHostDenoConfig = picked as { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> };
        }
      } catch (e: unknown) {
        console.error(`[hv] error loading host deno config`, { error: (e as Error)?.message });
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
      denoArgs.push(`--no-prompt`);
    }

    // Decide whether to use --reload based on invalidateCacheAt vs last load
    let shouldReload = false;
    if (selected.invalidateCacheAt !== undefined) {
      const last = projectLastLoad.get(project) ?? 0;
      let invalidateAt = 0;
      if (selected.invalidateCacheAt instanceof Date) invalidateAt = selected.invalidateCacheAt.getTime();
      else if (typeof selected.invalidateCacheAt === "number") invalidateAt = selected.invalidateCacheAt;
      else if (typeof selected.invalidateCacheAt === "string") {
        const t = Date.parse(selected.invalidateCacheAt);
        if (!Number.isNaN(t)) invalidateAt = t;
      }
      if (invalidateAt > last) shouldReload = true;
    }
    if (shouldReload) {
      const reloadTargets: string[] = [];
      try {
        const rootResolved = await resolver.resolve("");
        if (rootResolved) reloadTargets.push(rootResolved.toString());
      } catch { /* ignore */ }
      if (selected.config) reloadTargets.push(selected.config);
      if (reloadTargets.length > 0) {
        const normalized: string[] = [];
        for (const t of reloadTargets) {
          const isUrl = t.split(":").length > 1;
          if (!isUrl) {
            try { normalized.push((await resolver.resolve(t)).toString()); } catch { normalized.push(t); }
          } else normalized.push(t);
        }
        const value = normalized.join(",");
        denoArgs.push(`--reload=${value}`);
      }
    }

    denoArgs.push(`${import.meta.resolve('../../cli.ts')}`);

    const globalSource = Deno.args.find((a) => a.startsWith("--source="))?.split("=")[1];
    const globalConfig = Deno.args.find((a) => a.startsWith("--config="))?.split("=")[1];
    const projCfg = (hv.projects && (hv.projects as Record<string, { source?: string; config?: string }>)[project]) || {} as { source?: string; config?: string };
    const effectiveSource = selected.source ?? projCfg.source ?? globalSource;
    const effectiveConfig = selected.config ?? projCfg.config ?? globalConfig;

    const finalScriptArgs = [
      `--port=${port}`,
      ...scriptArgs.filter((a) => !a.startsWith("--port=")),
      ...Deno.args.filter((a) => !a.startsWith("--source=") && !a.startsWith("--config=") && !a.startsWith("--hypervisor=")),
      ...(effectiveSource ? [`--source=${effectiveSource}`] : []),
      ...(effectiveConfig ? [`--config=${effectiveConfig}`] : []),
    ];

    const spawnEnv: Record<string, string> | undefined = { ...(selected.env || {}), ...(selected.githubToken ? { GITHUB_TOKEN: selected.githubToken } : {}) };
    spawnEnv.DENO_AUTH_TOKENS = `${spawnEnv.DENO_AUTH_TOKENS ? spawnEnv.DENO_AUTH_TOKENS + ";" : ""}${selected.githubToken ? `${selected.githubToken}@raw.githubusercontent.com` : ""}`;

    const projectDir = selected.isolated ? `./deno/${project}` : Deno.cwd();
    if (selected.isolated) {
      ensureDir(`${projectDir}`);
      spawnEnv.DENO_DIR = `./DENO_DIR`;
      finalScriptArgs.push(`--allow-read=${projectDir + "/**/*"}`);
      finalScriptArgs.push(`--allow-write=${projectDir + "/**/*"}`);
    }

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
    // mark last load time for reload decisions
    projectLastLoad.set(project, Date.now());

    attachExitObserver(project, proc);
    return { port, proc };
  }

  async function restartProject(project: string, denoOptionsIn?: string[], scriptArgsIn?: string[]) {
    if (restarting.has(project)) return;
    restarting.add(project);
    try {
      const idx = getProjectIndex(project) ?? 0;
      console.log(`[hv] restart requested`, { project });
      const next = await spawnWorker({ project }, idx, denoOptionsIn ?? cachedDenoOptions, scriptArgsIn ?? cachedScriptArgs);
      const existing = pools.get(project);
      if (!existing) {
        pools.set(project, { port: next.port, proc: next.proc, rr: rrPicker([{ port: next.port, proc: next.proc }]) });
        notifyProjectReady(project);
        if (onProjectReady) await onProjectReady(project);
        return;
      }
      const oldProc = existing.proc;
      const oldPort = existing.port;
      existing.port = next.port;
      existing.proc = next.proc;
      existing.rr = rrPicker([{ port: next.port, proc: next.proc }]);
      pools.set(project, existing);
      notifyProjectReady(project);
      if (onProjectReady) await onProjectReady(project);
      try { oldProc.kill(); } catch (_e) { /* ignore kill */ }
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
    return Array.from(pools.entries()).map(([project, entry]) => ({ project, entry }));
  }

  return {
    setBaseArgs,
    notifyProjectReady,
    waitForProjectReady,
    spawnWorker,
    restartProject,
    registerWorker,
    getPool,
    listProjects,
    setProjectIndex,
    getProjectIndex,
    ensureWorker,
    getPoolsArray,
  } as const;
}


