import type { EffectiveConfig } from "../config/types.ts";
import denoJson from "../../deno.json" with { type: "json" };

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
    } catch { }
  }
  return undefined;
}

function rrPicker<T>(arr: T[]) {
  let i = 0;
  return () => { const v = arr[i % Math.max(arr.length, 1)]; i++; return v; };
}

export async function startHypervisor(config: EffectiveConfig, baseArgs: string[] = []) {
  const hv = config.runtime?.hv ?? {};
  const publicPort = config.server?.port ?? 8080;
  const basePort = hv.workerBasePort ?? 9101;

  // Determine projects from config (simplest: single default)
  const projects = hv.projects && Object.keys(hv.projects).length > 0 ? Object.keys(hv.projects) : ["default"];

  const pools = new Map<string, { port: number; proc: Deno.ChildProcess; rr: () => { port: number; proc: Deno.ChildProcess } }>();

  // Determine deno config to forward
  const hostDenoCfg = (Deno.args.find((a) => a.startsWith("--deno-config="))?.split("=")[1])
    || hv.denoConfig
    || await detectHostDenoConfig(config.root ?? Deno.cwd());


  for (let idx = 0; idx < projects.length; idx++) {
    const project = projects[idx];
    const port = basePort + idx;
    const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);
    const denoArgs: string[] = ["run", "-A", ...denoOptions];
    if (!denoOptions.includes("--config") && hostDenoCfg) {
      // load hostDenoConfig, merge with denoJson and pass as dataUrl to --config
      let maybeHostDenoConfig;
      try {
        maybeHostDenoConfig = (await import(hostDenoCfg, { with: { type: "json" } })).default;
      } catch (e) {
        // fallback: try as text and parse as JSON
        const text = await (await import(hostDenoCfg, { with: { type: "text" } })).default;
        try {
          maybeHostDenoConfig = JSON.parse(text);
        } catch {
          maybeHostDenoConfig = {};
        }
      }

      const mergedImportMap = {
        imports: {
          ...denoJson.imports,
          ...(maybeHostDenoConfig || {}).imports
        },
        scopes: {
          ...((denoJson as any)?.scopes || {}),
          ...(maybeHostDenoConfig || {}).scopes
        }
      }
      // data: URL must be a valid JSON string, not a Uint8Array
      const jsonStr = JSON.stringify(mergedImportMap);
      const dataUrl = `data:application/json;base64,${btoa(jsonStr)}`;
      denoArgs.push(`--import-map=${dataUrl}`);

    }
    denoArgs.push(`${import.meta.resolve('../../cli.ts')}`);
    const finalScriptArgs = [
      `--port=${port}`,
      ...scriptArgs.filter((a) => !a.startsWith("--port=")),
      // forward global flags we already support
      ...Deno.args.filter((a) => a.startsWith("--source=") || a.startsWith("--config=")),
    ];

    const proc = new Deno.Command(Deno.execPath(), {
      args: [...denoArgs, ...finalScriptArgs],
      // stdout: "null",
      // stderr: "null"
    }).spawn();
    // Wait until ready

    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try { const r = await fetch(`http://localhost:${port}/`, { method: "HEAD" }); if (r.ok || r.status >= 200) break; } catch { }
      console.log('waiting for port', port)
    }
    pools.set(project, { port, proc, rr: rrPicker([{ port, proc }]) });
  }

  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

    // Very simple selection: pathPrefix based on hv.projects[NAME].routing.basePath
    let selected = "default";
    if (hv.select && Array.isArray(hv.select)) {
      for (const rule of hv.select) {
        if ((rule as any).default) { selected = (rule as any).project; continue; }
        const r = rule as { project: string; when: { pathPrefix?: string; hostEquals?: string; hostPrefix?: string; hostSuffix?: string; method?: string; header?: Record<string, string | RegExp> } };
        let ok = true;
        if (r.when.pathPrefix && !url.pathname.startsWith(r.when.pathPrefix)) ok = false;
        if (r.when.method && req.method !== r.when.method) ok = false;
        if (r.when.hostEquals && url.hostname !== r.when.hostEquals) ok = false;
        if (r.when.hostPrefix && !url.hostname.startsWith(r.when.hostPrefix)) ok = false;
        if (r.when.hostSuffix && !url.hostname.endsWith(r.when.hostSuffix)) ok = false;
        if (r.when.header) {
          for (const [k, v] of Object.entries(r.when.header)) {
            const hv = req.headers.get(k);
            if (v instanceof RegExp) { if (!hv || !v.test(hv)) ok = false; }
            else { if (hv !== v) ok = false; }
          }
        }
        if (ok) { selected = r.project; break; }
      }
    }

    const pool = pools.get(selected) ?? pools.get("default")!;

    let pathname = url.pathname;
    const basePath = hv.projects?.[selected]?.routing?.basePath;
    if (basePath && basePath !== "/" && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || "/";
    }

    const target = `http://localhost:${pool.port}${pathname}${url.search}`;

    const headers = new Headers(req.headers);
    if (hv.proxy?.passRequestId) {
      const hdr = config.logging?.requestIdHeader ?? "x-request-id";
      if (!headers.has(hdr)) headers.set(hdr, crypto.randomUUID());
    }

    try {
      const res = await fetch(target, { method: req.method, headers, body: req.body });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      const body = JSON.stringify({ error: { message: (e as Error).message || "Upstream error" } });
      return new Response(body, { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  });

  await server.finished;
  for (const p of pools.values()) {
    try { p.proc.kill(); await p.proc.output(); } catch { }
  }
} 