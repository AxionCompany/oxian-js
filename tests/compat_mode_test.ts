/// <reference lib="deno.ns" />
import { delay } from "jsr:@std/async/delay";

async function waitForReady(url: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(url, { method: "HEAD" }); if (res.ok || res.status >= 200) return; } catch {}
    await delay(50);
  }
  throw new Error("server not ready");
}

async function startServer(port: number, configFile = "oxian.config.ts") {
  const proc = new Deno.Command("deno", { args: ["run", "-A", "cli.ts", `--port=${port}`, `--config=${configFile}`], stdout: "piped", stderr: "piped" }).spawn();
  await waitForReady(`http://localhost:${port}/`);
  return proc;
}

Deno.test("compat: handlerMode 'this' logs deprecation and returns value", async () => {
  await Deno.mkdir("routes/compat_this", { recursive: true });
  await Deno.writeTextFile("routes/compat_this/dependencies.ts", "export default ()=>({ val: 'ok-this' });\n");
  await Deno.writeTextFile("routes/compat_this/index.ts", "export function GET(d,{response}){ return (this && this.val) || 'none'; }\n" );
  await Deno.writeTextFile("oxian.config.ts", "export default { compatibility: { handlerMode: 'this' } }\n");
  const proc = await startServer(8138);
  try {
    const res = await fetch("http://localhost:8138/compat_this", { headers: { authorization: "Bearer x" } });
    const text = await res.text();
    if (text.trim() !== "ok-this") throw new Error("unexpected response");
  } finally {
    try { proc.kill(); } catch {}
    const out = await proc.output();
    const text = new TextDecoder().decode(out.stdout);
    if (!text.includes("deprecation") || !text.includes("handlerMode 'this'")) throw new Error("expected deprecation log for handlerMode 'this'");
    await Deno.remove("routes/compat_this/dependencies.ts").catch(()=>{});
    await Deno.remove("routes/compat_this/index.ts").catch(()=>{});
    await Deno.remove("routes/compat_this", { recursive: true }).catch(()=>{});
    await Deno.remove("oxian.config.ts").catch(()=>{});
  }
});

Deno.test("compat: handlerMode 'factory' logs deprecation and returns value", async () => {
  await Deno.mkdir("routes/compat_factory", { recursive: true });
  await Deno.writeTextFile("routes/compat_factory/dependencies.ts", "export default ()=>({ val: 'ok-factory' });\n");
  await Deno.writeTextFile("routes/compat_factory/index.ts", "export default (deps)=> (d,{response})=> deps.val;\n");
  await Deno.writeTextFile("oxian.config.ts", "export default { compatibility: { handlerMode: 'factory' } }\n");
  const proc = await startServer(8139);
  try {
    const res = await fetch("http://localhost:8139/compat_factory", { headers: { authorization: "Bearer x" } });
    const text = await res.text();
    if (text.trim() !== "ok-factory") throw new Error("unexpected response");
  } finally {
    try { proc.kill(); } catch {}
    const out = await proc.output();
    const text = new TextDecoder().decode(out.stdout);
    if (!text.includes("deprecation") || !text.includes("handlerMode 'factory'")) throw new Error("expected deprecation log for handlerMode 'factory'");
    await Deno.remove("routes/compat_factory/dependencies.ts").catch(()=>{});
    await Deno.remove("routes/compat_factory/index.ts").catch(()=>{});
    await Deno.remove("routes/compat_factory", { recursive: true }).catch(()=>{});
    await Deno.remove("oxian.config.ts").catch(()=>{});
  }
}); 