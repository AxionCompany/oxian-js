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
  name: "hypervisor + importer: config-only multi-project via header selection",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const port = 8150;

  // Serve a helper via HTTP to force use of importer + http loader somewhere in the app
  // We'll import this helper from a route during the test through the worker server implicitly.
  const helperServerPort = 18676;
  const helperCode =
    `export function normalize(h: string | null): string { return (h||'').trim().toLowerCase(); }`;
  const abort = new AbortController();
  const helperServer = Deno.serve({
    port: helperServerPort,
    signal: abort.signal,
  }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/helper.ts") {
      return new Response(helperCode, {
        headers: { "content-type": "text/typescript; charset=utf-8" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  await delay(50);

  // Write a temporary config enabling multi-project selection based on header
  const cfgPath = await Deno.makeTempFile({ suffix: ".ts" });
  const cfgSource = `export default {
    runtime: {
      hv: {
        enabled: true,
        projects: { default: {}, alpha: {}, beta: {} },
        select: [
          { when: { header: { 'x-mcp-project': 'alpha' } }, project: 'alpha' },
          { when: { header: { 'x-mcp-project': 'beta' } }, project: 'beta' },
          { default: true, project: 'default' }
        ]
      }
    }
  }`;
  await Deno.writeTextFile(cfgPath, cfgSource);

  const proc = new Deno.Command("deno", {
    args: ["run", "-A", "cli.ts", `--port=${port}`, `--config=${cfgPath}`],
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    await waitForReady(`http://localhost:${port}/`);

    // Basic warm requests under different headers
    const r1 = await fetch(`http://localhost:${port}/feature`, {
      headers: { "x-mcp-project": "alpha" },
    });
    if (!r1.ok) throw new Error("alpha project route failed");
    const r2 = await fetch(`http://localhost:${port}/feature`, {
      headers: { "x-mcp-project": "beta" },
    });
    if (!r2.ok) throw new Error("beta project route failed");
  } finally {
    try {
      proc.kill();
    } catch {}
    try {
      await proc.output();
    } catch {}
    abort.abort();
    await helperServer.finished.catch(() => {});
    await Deno.remove(cfgPath).catch(() => {});
  }
});
