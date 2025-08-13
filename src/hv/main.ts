import type { EffectiveConfig } from "../config/types.ts";
import denoJson from "../../deno.json" with { type: "json" };
import { getLocalRootPath } from "../utils/root.ts";
import { isAbsolute, toFileUrl, join } from "@std/path";

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
  const projects = hv.projects && Object.keys(hv.projects).length > 0 ? Object.keys(hv.projects) : ["default"];

  const pools = new Map<string, { port: number; proc: Deno.ChildProcess; rr: () => { port: number; proc: Deno.ChildProcess } }>();

  // Determine deno config to forward
  let hostDenoCfg = (Deno.args.find((a) => a.startsWith("--deno-config="))?.split("=")[1])
    || hv.denoConfig
    || await detectHostDenoConfig(getLocalRootPath(config.root));

  if (hostDenoCfg) {
    // Normalize to URL string without relying on import.meta.resolve (works under jsr)
    try {
      // If already a URL, keep as-is
      const u = new URL(hostDenoCfg);
      hostDenoCfg = u.toString();
    } catch {
      const path = isAbsolute(hostDenoCfg) ? hostDenoCfg : join(Deno.cwd(), hostDenoCfg);
      hostDenoCfg = toFileUrl(path).toString();
    }
  }

  for (let idx = 0; idx < projects.length; idx++) {
    const project = projects[idx];
    const port = await findAvailablePort(basePort + idx);
    const { denoOptions, scriptArgs } = splitBaseArgs(baseArgs);
    const denoArgs: string[] = ["run", "-A", ...denoOptions];
    if (!denoOptions.includes("--config") && hostDenoCfg) {

      // load hostDenoConfig, merge with denoJson and pass as dataUrl to --config
      let maybeHostDenoConfig = { imports: {}, scopes: {} };
      try {
        maybeHostDenoConfig = (await import(hostDenoCfg, { with: { type: "json" } })).default;
      } catch (e: unknown) {
        console.error(`[hv] error loading host deno config`, { error: (e as Error)?.message });
        // ignore
      }
      const mergedImportMap = {
        imports: {
          ...denoJson.imports,
          ...(maybeHostDenoConfig || {}).imports
        },
        scopes: {
          ...(((denoJson as unknown as { scopes?: Record<string, unknown> })?.scopes) || {}),
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
      stdin: "null",    // child does not read from our TTY
      stdout: "inherit", // write directly to parent TTY (no double piping)
      stderr: "inherit",
    }).spawn();


    {
      const maxWaitMs = 10_000;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < maxWaitMs) {
        try {
          const r = await fetch(`http://localhost:${port}/_health`, { method: "HEAD", signal: AbortSignal.timeout(500) });
          if (r.ok || r.status >= 200) { ready = true; break; }
        } catch { /* ignore until ready */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!ready) console.error(`[hv] worker not ready`, { project, port, waitedMs: Date.now() - start });
      else console.log(`[hv] worker ready`, { project, port });
    }
    pools.set(project, { port, proc, rr: rrPicker([{ port, proc }]) });
  }

  console.log(`[hv] public listening`, { port: publicPort });
  const server = Deno.serve({ port: publicPort }, async (req) => {
    const url = new URL(req.url);

    // Very simple selection: pathPrefix based on hv.projects[NAME].routing.basePath
    let selected = "default";
    if (hv.select && Array.isArray(hv.select)) {
      const rules = hv.select as HvSelectionRule[];
      for (const rule of rules) {
        if (rule.default) { selected = rule.project; continue; }
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
      console.log(`[hv] proxy`, { method: req.method, url: url.toString(), selected, target });
      const res = await fetch(target, { method: req.method, headers, body: req.body, signal: (req as Request).signal });
      console.log(`[hv] proxy_res`, { status: res.status, statusText: res.statusText, target });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } catch (e) {
      console.error(`[hv] proxy_err`, { target, err: (e as Error)?.message });
      const body = JSON.stringify({ error: { message: (e as Error).message || "Upstream error" } });
      return new Response(body, { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  });

  await server.finished;
  for (const p of pools.values()) {
    try { p.proc.kill(); } catch (_e) { /* ignore kill error */ }
    try { await p.proc.status; } catch (_e) { /* ignore status error */ }
  }
} 