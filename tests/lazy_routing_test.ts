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

async function startServerLazy(port: number) {
  const proc = new Deno.Command("deno", {
    args: ["run", "-A", "cli.ts", `--port=${port}`, "--config=oxian.config.ts"],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  await waitForReady(`http://localhost:${port}/`);
  return proc;
}

Deno.test("lazy: index and param routing", async () => {
  const config = `export default { routing: { discovery: 'lazy' } }`;
  await Deno.writeTextFile("oxian.config.ts", config);
  const proc = await startServerLazy(8131);
  try {
    const root = await fetch("http://localhost:8131/");
    const rootJson = await root.json();
    if (rootJson.hello !== "world") throw new Error("unexpected root");

    let res = await fetch("http://localhost:8131/users/1", {
      headers: { authorization: "Bearer a" },
    });
    const json = await res.json();
    if (json.id !== "1") throw new Error("param route failed");

    const ca = await fetch("http://localhost:8131/docs/guide/intro");
    const caj = await ca.json();
    if (!caj.slug) throw new Error("catch-all failed");
  } finally {
    try {
      proc.kill();
    } catch {}
    await proc.output();
    try {
      await Deno.remove("oxian.config.ts");
    } catch {}
  }
});
