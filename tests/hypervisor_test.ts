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

Deno.test({ name: "hypervisor: basic proxy and streaming", sanitizeOps: false, sanitizeResources: false }, async () => {
  const port = 8140;
  const proc = new Deno.Command("deno", { args: ["run", "-A", "cli.ts", `--port=${port}`, "--hypervisor"], stdout: "piped", stderr: "piped" }).spawn();
  try {
    await waitForReady(`http://localhost:${port}/`);
    let res = await fetch(`http://localhost:${port}/`);
    let json = await res.json();
    if (json.hello !== "world") throw new Error("unexpected root response through HV");
    res = await fetch(`http://localhost:${port}/stream`);
    const text = await res.text();
    if (!text.includes("hello") || !text.includes("world")) throw new Error("unexpected stream body through HV");
  } finally {
    try { proc.kill(); } catch {}
    try { await proc.output(); } catch {}
  }
});

// Provider-based routing removed in new HV design (config-only). Test omitted.

Deno.test({ name: "hypervisor: sticky routing by header", sanitizeOps: false, sanitizeResources: false }, async () => {
  const port = 8142;
  const proc = new Deno.Command("deno", { args: ["run", "-A", "cli.ts", `--port=${port}`, "--hypervisor"], stdout: "piped", stderr: "piped" }).spawn();
  try {
    await waitForReady(`http://localhost:${port}/`);
    const hdr = { "x-session-id": "abc" };
    const ctl1 = new AbortController();
    const ctl2 = new AbortController();
    const t1 = setTimeout(() => ctl1.abort(), 3000);
    const t2 = setTimeout(() => ctl2.abort(), 3000);
    try {
      const a = await fetch(`http://localhost:${port}/feature`, { headers: hdr, signal: ctl1.signal });
      const b = await fetch(`http://localhost:${port}/feature`, { headers: hdr, signal: ctl2.signal });
      if (!a.ok || !b.ok) throw new Error("sticky requests failed");
    } finally {
      clearTimeout(t1); clearTimeout(t2);
    }
  } finally {
    try { proc.kill(); } catch {}
    try { await proc.output(); } catch {}
  }
}); 