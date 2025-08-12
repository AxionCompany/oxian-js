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

async function startServer(port: number) {
  const proc = new Deno.Command("deno", { args: ["run", "-A", "cli.ts", `--port=${port}`], stdout: "piped", stderr: "piped" }).spawn();
  await waitForReady(`http://localhost:${port}/`);
  return proc;
}

Deno.test("SSE route emits events and closes", async () => {
  const proc = await startServer(8136);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch("http://localhost:8136/sse");
    if (!res.body) throw new Error("no body");
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let dataEvents = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (evt.includes("data:")) dataEvents++;
      }
      if (dataEvents >= 3) {
        // we saw enough events; cancel to close and avoid leaks
        await reader.cancel();
        break;
      }
    }
    if (dataEvents < 3) throw new Error("expected at least 3 events");
  } finally {
    try { await reader?.cancel(); } catch {}
    try { proc.kill(); } catch {}
    await proc.output();
  }
}); 