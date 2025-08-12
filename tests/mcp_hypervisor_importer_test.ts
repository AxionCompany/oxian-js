/// <reference lib="deno.ns" />
import { delay } from "jsr:@std/async/delay";

async function waitForReady(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok || res.status >= 200) return;
    } catch {}
    await delay(50);
  }
  throw new Error("server not ready");
}

Deno.test({
  name: "hypervisor + importer: manage multiple MCP-like projects (process only)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const port = 8150;

  // Serve provider and helper via HTTP to force use of importer + http loader
  const providerServerPort = 18675;
  const providerCode = `
import { mapHeaderToProject } from "http://localhost:${providerServerPort}/helper.ts";

export async function pickProject(req: Request) {
  const proj = mapHeaderToProject(req.headers.get("x-mcp-project"));
  const prefix = req.headers.get("x-mcp-prefix") ?? undefined;
  return prefix ? { project: proj, stripPathPrefix: prefix } : { project: proj };
}

export async function getProjectConfig(name: string) {
  // Keep both as process workers to avoid thread permission constraints in CI
  return { name, worker: { kind: "process" } };
}
`;
  const helperCode = `
export function mapHeaderToProject(h: string | null): string {
  if (!h) return "default";
  if (h === "alpha") return "alpha";
  if (h === "beta") return "beta";
  return "default";
}
`;
  const abort = new AbortController();
  const providerServer = Deno.serve({ port: providerServerPort, signal: abort.signal }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/provider.ts") {
      return new Response(providerCode, { headers: { "content-type": "text/typescript; charset=utf-8" } });
    }
    if (url.pathname === "/helper.ts") {
      return new Response(helperCode, { headers: { "content-type": "text/typescript; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  });
  // Wait a moment for server to bind
  await delay(50);

  const providerUrl = `http://localhost:${providerServerPort}/provider.ts`;

  // Preflight: ensure importer can bundle and load the provider
  {
    const { createLoaderManager } = await import("../src/loader/index.ts");
    const { importModule } = await import("../src/runtime/importer.ts");
    const lm = createLoaderManager(Deno.cwd());
    const url = lm.resolveUrl(providerUrl);
    const mod = await importModule(url, lm.getLoaders());
    if (typeof (mod as any).pickProject !== "function") {
      throw new Error("preflight: provider pickProject not exported");
    }
  }

  const proc = new Deno.Command("deno", {
    args: ["run", "-A", "cli.ts", `--port=${port}`, "--hypervisor", `--provider=module:${providerUrl}`],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    await waitForReady(`http://localhost:${port}/`);

    // Create alpha and beta pools explicitly via admin endpoints
    const upA = await fetch(`http://localhost:${port}/_hv/scaleUp?project=alpha`);
    if (!upA.ok) throw new Error("scaleUp alpha failed");
    const upB = await fetch(`http://localhost:${port}/_hv/scaleUp?project=beta`);
    if (!upB.ok) throw new Error("scaleUp beta failed");

    // Warm both project pools by making initial requests
    const r1 = await fetch(`http://localhost:${port}/feature`, { headers: { "x-mcp-project": "alpha" } });
    if (!r1.ok) throw new Error("alpha project route failed");
    const r2 = await fetch(`http://localhost:${port}/feature`, { headers: { "x-mcp-project": "beta" } });
    if (!r2.ok) throw new Error("beta project route failed");

    // Inspect hypervisor status to ensure both pools exist and have workers
    const statusRes = await fetch(`http://localhost:${port}/_hv/status`);
    const statusJson = await statusRes.json() as { status: Array<{ name: string; workers: Array<{ port: number; healthy: boolean; inflight: number; kind: string }>}> };
    const names = statusJson.status.map((s) => s.name).sort();
    if (!(names.includes("alpha") && names.includes("beta"))) {
      throw new Error(`expected alpha and beta pools, got: ${names.join(",")}`);
    }

    // Exercise additional scale up for alpha
    const scaleUp = await fetch(`http://localhost:${port}/_hv/scaleUp?project=alpha`);
    if (!scaleUp.ok) throw new Error("additional scaleUp failed");
    await delay(200);
    const status2 = await (await fetch(`http://localhost:${port}/_hv/status`)).json() as { status: Array<{ name: string; workers: unknown[] }> };
    const alphaWorkers = status2.status.find((s) => s.name === "alpha")?.workers.length ?? 0;
    if (alphaWorkers < 2) throw new Error("scaleUp did not add a worker to alpha");

    // Make more requests to both projects to ensure proxying continues to work after scaling
    const okA = await fetch(`http://localhost:${port}/feature`, { headers: { "x-mcp-project": "alpha" } });
    const okB = await fetch(`http://localhost:${port}/feature`, { headers: { "x-mcp-project": "beta" } });
    if (!okA.ok || !okB.ok) throw new Error("post-scale requests failed");
  } finally {
    try { proc.kill(); } catch {}
    try { await proc.output(); } catch {}
    abort.abort();
    await providerServer.finished.catch(() => {});
  }
}); 