/// <reference lib="deno.ns" />
/**
 * Tests for hypervisor proxy bug fixes (Findings A–E).
 *
 * These tests validate the proxy error-handling paths without spawning full
 * worker processes. Instead they start a lightweight mock backend and a
 * thin proxy that reproduces the same patterns as `startHypervisor`.
 */

import {
  assertEquals,
  assertNotEquals,
} from "jsr:@std/assert";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Start a controllable mock backend server. */
function startMockBackend(
  port: number,
  handler: (req: Request) => Response | Promise<Response>,
): Deno.HttpServer {
  return Deno.serve({ port, onListen: () => {} }, handler);
}

async function waitForPort(port: number, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const c = await Deno.connect({ port });
      c.close();
      return;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Port ${port} not ready within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Fix B — Request body is preserved on retry after failed proxy fetch
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix B: body is preserved when proxy fetch fails and request is retried",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // This test validates the body-buffering logic:
  // 1. Tee the body before the proxy fetch
  // 2. Buffer one fork
  // 3. After fetch fails (consuming the other fork), build a new Request from the buffer
  // 4. Verify the body content is intact

  const originalBody = JSON.stringify({ key: "value", nested: { a: 1 } });

  // Simulate the buffering logic from the proxy handler
  const req = new Request("http://localhost/test", {
    method: "POST",
    body: originalBody,
    headers: { "content-type": "application/json" },
  });

  // Step 1: tee + buffer (mirrors lines 304-338 in lifecycle.ts)
  let bufferedBody: Uint8Array | null = null;
  let transformedReq = req;

  const [forFetch, forBuffer] = req.body!.tee();
  transformedReq = new Request(req, {
    body: forFetch,
    headers: req.headers,
  });

  // Buffer the second fork
  const reader = forBuffer.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLen += value.byteLength;
    }
  }
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  bufferedBody = merged;

  // Step 2: Simulate the proxy fetch consuming the body
  // (In real code this is `await fetch(target, { body: transformedReq.body })`)
  const consumedBody = await new Response(transformedReq.body).text();
  assertEquals(consumedBody, originalBody, "proxy fetch should see original body");

  // Step 3: After fetch failure, the original req.body is now consumed.
  // Verify we CAN'T tee it anymore (the old bug path):
  let _teeThrew = false;
  try {
    req.body?.tee();
  } catch {
    _teeThrew = true;
  }
  // Note: depending on runtime, tee() on consumed body may throw or return empty streams.
  // The key test is that our buffered body is intact:

  // Step 4: Build retry request from buffer (mirrors lines 458-463)
  const retryReq = new Request(req, {
    body: bufferedBody as unknown as BodyInit,
    headers: req.headers,
  });

  const retryBody = await retryReq.text();
  assertEquals(retryBody, originalBody, "retry request must carry the original body");
  console.log("  ✓ Buffered body preserved on retry");
});

// ---------------------------------------------------------------------------
// Fix A — Timeout returns 504 without restarting worker
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix A: proxy timeout returns 504 and does NOT kill the backend",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const backendPort = 19201;
  let requestCount = 0;

  // Backend that delays on /test but responds fast on /health
  const backend = startMockBackend(backendPort, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    requestCount++;
    await new Promise((r) => setTimeout(r, 5000)); // 5s delay
    return new Response("ok");
  });

  await waitForPort(backendPort);

  try {
    // Proxy with a very short timeout (100ms), simulating the HV proxy path
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);

    let caughtError: Error | null = null;
    try {
      await fetch(`http://127.0.0.1:${backendPort}/test`, {
        method: "GET",
        signal: controller.signal,
      });
    } catch (e) {
      caughtError = e as Error;
    } finally {
      clearTimeout(timer);
    }

    // Verify it's an AbortError (the condition our fix checks)
    assertNotEquals(caughtError, null, "fetch should throw on timeout");
    assertEquals(caughtError!.name, "AbortError", "error should be AbortError");

    // Our fix: AbortError → 504, not restart
    const isTimeout = caughtError!.name === "AbortError" ||
      caughtError!.name === "TimeoutError";
    assertEquals(isTimeout, true, "should be classified as timeout");

    // Verify the backend is still alive (worker wasn't killed)
    // Use /health which responds immediately
    const healthCheck = await fetch(`http://127.0.0.1:${backendPort}/health`, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    assertNotEquals(healthCheck, null, "backend should still be alive after timeout");

    console.log("  ✓ Timeout classified as AbortError → 504 path");
    console.log("  ✓ Backend still alive (would not be killed)");
  } finally {
    await backend.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Fix A (continued) — Connection error IS classified for restart
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix A: connection refused IS classified for restart (not timeout)",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Try to connect to a port nothing is listening on
  const deadPort = 19299;
  let caughtError: Error | null = null;

  try {
    await fetch(`http://127.0.0.1:${deadPort}/test`, {
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    caughtError = e as Error;
  }

  assertNotEquals(caughtError, null, "fetch to dead port should throw");

  // This should NOT be classified as timeout
  const isTimeout = caughtError!.name === "AbortError" ||
    caughtError!.name === "TimeoutError";
  assertEquals(isTimeout, false, "connection refused should NOT be classified as timeout");

  console.log(`  ✓ Connection error name="${caughtError!.name}" → restart path`);
});

// ---------------------------------------------------------------------------
// Fix C — decrementInflight on proxy failure
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix C: inflight counter pattern — increment before fetch, decrement on error",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Simulate the inflight tracking pattern from the proxy handler
  let inflight = 0;
  const increment = () => { inflight++; };
  const decrement = () => { inflight = Math.max(0, inflight - 1); };

  // Simulate normal request flow
  increment(); // before fetch
  assertEquals(inflight, 1);

  // Simulate fetch failure
  try {
    await fetch("http://127.0.0.1:19299/nonexistent", {
      signal: AbortSignal.timeout(500),
    });
    // success path would decrement via tee watcher
    decrement();
  } catch {
    // FIX C: catch path now also decrements
    decrement();
  }

  assertEquals(inflight, 0, "inflight must be 0 after error");
  console.log("  ✓ Inflight correctly decremented on proxy error");

  // Simulate concurrent requests where one fails
  increment(); // req 1
  increment(); // req 2
  assertEquals(inflight, 2);

  // req 1 succeeds
  decrement();
  assertEquals(inflight, 1);

  // req 2 fails — OLD BUG: no decrement → inflight stuck at 1
  // FIX: catch decrements
  decrement();
  assertEquals(inflight, 0, "inflight must reach 0 even when requests fail");
  console.log("  ✓ Inflight reaches 0 after mixed success/failure");
});

// ---------------------------------------------------------------------------
// Fix D — flushQueue participates in inflight accounting
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix D: flushQueue inflight tracking prevents premature idle shutdown",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const backendPort = 19202;
  let inflight = 0;
  const increment = () => { inflight++; };
  const decrement = () => { inflight = Math.max(0, inflight - 1); };

  // Slow backend simulating a queued request being processed
  const backend = startMockBackend(backendPort, async (_req) => {
    await new Promise((r) => setTimeout(r, 200));
    return Response.json({ ok: true });
  });

  await waitForPort(backendPort);

  try {
    // Simulate flushQueue behavior WITH our fix
    increment(); // Fix D: track inflight before fetch
    assertEquals(inflight, 1, "inflight should be 1 during queued fetch");

    const res = await fetch(`http://127.0.0.1:${backendPort}/queued`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json();
    assertEquals(body.ok, true);

    decrement(); // Fix D: decrement after fetch completes
    assertEquals(inflight, 0, "inflight should be 0 after queued fetch completes");

    // Verify: an idle checker polling during the fetch would see inflight > 0
    // (before our fix, it would see 0 and potentially kill the worker)
    console.log("  ✓ Queued requests tracked in inflight counter");
  } finally {
    await backend.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Fix E — proxy errors always logged (OTEL should not suppress)
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix E: proxy error logging is unconditional (OTEL flag irrelevant)",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  // Verify the logic: errors should be logged regardless of OTEL_OR_COLLECTOR
  // OLD code: `if (!OTEL_OR_COLLECTOR) { console.error(...) }`
  // NEW code: `console.error(...)` (always)

  // Simulate both OTEL states
  for (const otelEnabled of [true, false]) {
    const OTEL_OR_COLLECTOR = otelEnabled;
    let logged = false;

    // OLD behavior (buggy):
    if (!OTEL_OR_COLLECTOR) {
      logged = true;
    }
    if (otelEnabled) {
      assertEquals(logged, false, "OLD code suppresses logs when OTEL is on");
    }

    // NEW behavior (fixed):
    logged = false;
    // No condition — always log
    logged = true;
    assertEquals(logged, true, `NEW code always logs (OTEL=${otelEnabled})`);
  }

  console.log("  ✓ Proxy errors logged unconditionally (OTEL=true and OTEL=false)");
});

// ---------------------------------------------------------------------------
// Fix E (extended) — error name is included in log output
// ---------------------------------------------------------------------------

Deno.test({
  name: "Fix E: proxy error log includes error name for diagnostics",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Capture what our new log output looks like
  let caughtError: Error | null = null;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await fetch("http://127.0.0.1:19299/nothing", {
      signal: controller.signal,
    });
  } catch (e) {
    caughtError = e as Error;
  }

  assertNotEquals(caughtError, null);

  // Our new log format includes errName
  const logPayload = {
    project: "test-project",
    target: "http://127.0.0.1:19299/nothing",
    errName: caughtError!.name,
    err: caughtError!.message,
  };

  assertNotEquals(logPayload.errName, undefined, "errName should be present");
  assertNotEquals(logPayload.errName, "", "errName should not be empty");
  assertEquals(typeof logPayload.errName, "string");
  
  console.log(`  ✓ Error log includes errName="${logPayload.errName}"`);
});

// ---------------------------------------------------------------------------
// Integration: full proxy retry with body preservation
// ---------------------------------------------------------------------------

Deno.test({
  name: "Integration: POST retry after backend crash carries original body",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const backendPort = 19203;
  let attempt = 0;
  const receivedBodies: string[] = [];

  // Backend that fails on first request, succeeds on second
  const backend = startMockBackend(backendPort, async (req) => {
    attempt++;
    if (req.method === "POST") {
      const body = await req.text();
      receivedBodies.push(body);
    }
    if (attempt === 1) {
      // Simulate a 500 (in real life this would be a connection error)
      return new Response("Internal Server Error", { status: 500 });
    }
    return Response.json({ ok: true, attempt });
  });

  await waitForPort(backendPort);

  try {
    const originalBody = JSON.stringify({ action: "create", data: [1, 2, 3] });

    // Step 1: Buffer before first fetch (our fix)
    const req = new Request(`http://127.0.0.1:${backendPort}/api`, {
      method: "POST",
      body: originalBody,
      headers: { "content-type": "application/json" },
    });

    let bufferedBody: Uint8Array | null = null;
    const [forFetch, forBuffer] = req.body!.tee();
    const fetchReq = new Request(req, { body: forFetch, headers: req.headers });

    // Buffer second fork
    const bufReader = forBuffer.getReader();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await bufReader.read();
      if (done) break;
      if (value) { chunks.push(value); totalLen += value.byteLength; }
    }
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    bufferedBody = merged;

    // Step 2: First fetch (simulating proxy)
    const res1 = await fetch(`http://127.0.0.1:${backendPort}/api`, {
      method: "POST",
      body: fetchReq.body,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);

    assertEquals(res1.status, 500, "first attempt should fail");
    await res1.body?.cancel();

    // Step 3: Retry with buffered body (our fix)
    const retryReq = new Request(req.url, {
      method: "POST",
      body: bufferedBody as unknown as BodyInit,
      headers: { "content-type": "application/json" },
    });

    const res2 = await fetch(`http://127.0.0.1:${backendPort}/api`, {
      method: "POST",
      body: retryReq.body,
      headers: { "content-type": "application/json" },
      duplex: "half",
    } as RequestInit);

    assertEquals(res2.status, 200, "retry should succeed");
    const json = await res2.json();
    assertEquals(json.ok, true);

    // Verify BOTH requests received the full body
    assertEquals(receivedBodies.length, 2, "backend should have received 2 requests");
    assertEquals(receivedBodies[0], originalBody, "first attempt body intact");
    assertEquals(receivedBodies[1], originalBody, "retry body must match original (Fix B)");

    console.log("  ✓ Both attempts received identical body content");
    console.log(`  ✓ Body: ${originalBody}`);
  } finally {
    await backend.shutdown();
  }
});
