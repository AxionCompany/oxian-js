/// <reference lib="deno.ns" />
import { delay } from "https://deno.land/std@0.224.0/async/delay.ts";

async function waitForReady(url: string, timeoutMs = 5000) {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok || res.status >= 200) return;
    } catch (e) {
      lastErr = e;
    }
    await delay(50);
  }
  throw lastErr ?? new Error("server not ready");
}

async function startServer(port: number) {
  const proc = new Deno.Command("deno", { args: ["run", "-A", "cli.ts", `--port=${port}`], stdout: "piped", stderr: "piped" }).spawn();
  await waitForReady(`http://localhost:${port}/`);
  return proc;
}

Deno.test("root hello world", async () => {
  const proc = await startServer(8123);
  const res = await fetch("http://localhost:8123/");
  const json = await res.json();
  try {
    if (json.hello !== "world") throw new Error("unexpected root response");
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("param route unauthorized then authorized", async () => {
  const proc = await startServer(8124);
  try {
    let res = await fetch("http://localhost:8124/users/1");
    if (res.status !== 401) throw new Error("expected 401");
    await res.body?.cancel();
    res = await fetch("http://localhost:8124/users/1", { headers: { authorization: "Bearer x" } });
    const json = await res.json();
    if (json.id !== "1" || json.name !== "Ada") throw new Error("unexpected user");
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("trailing slash preserve default", async () => {
  const proc = await startServer(8125);
  try {
    const res = await fetch("http://localhost:8125/users/1/");
    if (res.status !== 401) throw new Error("expected 401");
    await res.body?.cancel();
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("streaming route", async () => {
  const proc = await startServer(8126);
  try {
    const res = await fetch("http://localhost:8126/stream");
    const text = await res.text();
    if (text !== "hello world") throw new Error("unexpected stream body");
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("catch-all slug", async () => {
  const proc = await startServer(8127);
  try {
    const res = await fetch("http://localhost:8127/docs/getting/started");
    const json = await res.json();
    if (json.slug !== "docs/getting/started" && json.slug !== "getting/started") {
      throw new Error("unexpected slug");
    }
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("interceptors order before/after", async () => {
  const proc = await startServer(8128);
  try {
    const res = await fetch("http://localhost:8128/order/a");
    const json = await res.json();
    if (!Array.isArray(json.before) || json.before[0] !== "root" || json.before[1] !== "a") {
      throw new Error("before order incorrect");
    }
    const afterHeader = res.headers.get("x-after");
    if (afterHeader !== "root,a") throw new Error("after order incorrect");
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("dependency composition override", async () => {
  const proc = await startServer(8129);
  try {
    const res = await fetch("http://localhost:8129/dep-compose/leaf");
    const json = await res.json();
    if (json.value !== 2) throw new Error("expected leaf to override root dependency");
  } finally {
    proc.kill();
    await proc.output();
  }
});

Deno.test("error mapping with statusCode", async () => {
  const proc = await startServer(8130);
  try {
    const res = await fetch("http://localhost:8130/error-map");
    if (res.status !== 418) throw new Error("expected 418");
    const json = await res.json();
    if (!json.error) throw new Error("expected error payload");
  } finally {
    proc.kill();
    await proc.output();
  }
}); 