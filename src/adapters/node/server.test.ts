import assert from "node:assert/strict";
import { connect as connectTcp } from "node:net";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import { serve } from "./server.ts";
import { createConnectionBudget } from "./connection-budget.ts";
import { WORKER_PROTOCOL } from "../../protocol/index.ts";

test("Node upgrade rejections preserve response status, headers, and body", async () => {
  const body = JSON.stringify({ error: "permission required", detail: "café" });
  const hypervisor = createHypervisor({
    transports: [
      {
        type: "in-process",
        config: { topic: `node-rejection-${crypto.randomUUID()}` },
      },
    ],
    fallback: () =>
      new Response(body, {
        status: 401,
        statusText: "Credentials Required",
        headers: [
          ["content-type", "application/json"],
          ["www-authenticate", 'Bearer realm="workers"'],
          ["retry-after", "30"],
          ["x-detail", "café"],
          ["set-cookie", "first=1; HttpOnly"],
          ["set-cookie", "second=2; HttpOnly"],
        ],
      }),
  });
  const listener = await serve({ hypervisor });
  try {
    const ordinary = await fetch(listener.url);
    assert.equal(ordinary.status, 401);
    assert.equal(await ordinary.text(), body);
    const ordinaryBytes = await requestBytes(listener.port, false);
    assert.equal(
      ordinaryBytes.toString("latin1").split("\r\n")[0],
      "HTTP/1.1 401 Credentials Required",
    );
    const response = await upgradeResponse(listener.port);
    assert.equal(response.statusLine, "HTTP/1.1 401 Credentials Required");
    assert.deepEqual(response.headers.get("www-authenticate"), [
      'Bearer realm="workers"',
    ]);
    assert.deepEqual(response.headers.get("retry-after"), ["30"]);
    assert.deepEqual(response.headers.get("content-type"), [
      "application/json",
    ]);
    assert.deepEqual(response.headers.get("x-detail"), ["café"]);
    assert.deepEqual(response.headers.get("set-cookie"), [
      "first=1; HttpOnly",
      "second=2; HttpOnly",
    ]);
    assert.deepEqual(
      response.headers.get("set-cookie"),
      ordinary.headers.getSetCookie(),
    );
    for (const name of [
      "www-authenticate",
      "retry-after",
      "content-type",
      "x-detail",
    ]) {
      assert.deepEqual(response.headers.get(name), [
        ordinary.headers.get(name),
      ]);
    }
    assert.equal(response.body.toString("utf8"), body);
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown("node_rejection_test");
  }
});

test("Node upgrade rejections use transport-owned response framing", async () => {
  const body = "not available: café";
  const hypervisor = createHypervisor({
    transports: [
      {
        type: "in-process",
        config: { topic: `node-rejection-framing-${crypto.randomUUID()}` },
      },
    ],
    fallback: () =>
      new Response(body, {
        status: 503,
        headers: {
          connection: "keep-alive",
          "content-length": "99999",
          "keep-alive": "timeout=30",
          "transfer-encoding": "chunked",
          trailer: "x-checksum",
          "retry-after": "1",
        },
      }),
  });
  const listener = await serve({ hypervisor });
  try {
    const response = await upgradeResponse(listener.port);
    assert.deepEqual(response.headers.get("connection"), ["close"]);
    assert.deepEqual(response.headers.get("content-length"), [
      String(Buffer.byteLength(body)),
    ]);
    assert.equal(response.headers.has("transfer-encoding"), false);
    assert.equal(response.headers.has("trailer"), false);
    assert.equal(response.headers.has("keep-alive"), false);
    assert.deepEqual(response.headers.get("retry-after"), ["1"]);
    assert.equal(response.body.toString("utf8"), body);
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown("node_rejection_framing_test");
  }
});

test("Node upgrade rejections validate all headers before writing", async () => {
  const hypervisor = createHypervisor({
    transports: [
      {
        type: "in-process",
        config: { topic: `node-rejection-headers-${crypto.randomUUID()}` },
      },
    ],
    fallback: () =>
      new Response("untrusted header", {
        status: 403,
        headers: { "x-invalid": "invalid\x01value" },
      }),
  });
  const listener = await serve({ hypervisor });
  try {
    const bytes = await requestBytes(listener.port);
    assert.equal(bytes.length, 0);
  } finally {
    await listener.shutdown();
    await hypervisor.shutdown("node_rejection_headers_test");
  }
});

for (const pending of ["fallback", "body"] as const) {
  test(`Node shutdown closes an upgrade waiting on ${pending}`, {
    timeout: 5_000,
  }, async () => {
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = 0;
    const budget = createConnectionBudget(1);
    const hypervisor = createHypervisor({
      transports: [
        { type: "in-process", config: { topic: crypto.randomUUID() } },
      ],
      fallback: () => {
        entered.resolve();
        return response.promise;
      },
    });
    const listener = await serve({ hypervisor, budget });
    const socket = connectTcp(listener.port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const peerClosed = Promise.withResolvers<void>();
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => undefined);
    socket.once("close", () => peerClosed.resolve());
    socket.once("connect", () =>
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      ),
    );
    const delayed = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
        cancel() {
          cancelled++;
        },
      }),
      { status: 404 },
    );
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      if (pending === "body") {
        response.resolve(delayed);
        while (!delayed.body!.locked)
          await new Promise((resolve) => setTimeout(resolve, 1));
      }
      assert.equal(budget.snapshot().connections, 1);
      closing = listener.shutdown();
      const done = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 500),
        ),
      ]);
      assert.equal(
        done,
        true,
        "shutdown must not await an upgraded fallback socket",
      );
      await peerClosed.promise;
      assert.equal(budget.snapshot().connections, 0);
      if (pending === "fallback") response.resolve(delayed);
      else body!.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        Buffer.concat(chunks).length,
        0,
        "late response must not write",
      );
      assert.equal(cancelled, pending === "fallback" ? 1 : 0);
      await listener.shutdown();
      assert.equal(budget.snapshot().connections, 0);
    } finally {
      socket.destroy();
      if (pending === "fallback") response.resolve(delayed);
      try {
        body?.close();
      } catch {
        /* Already closed or cancelled. */
      }
      await (closing ?? listener.shutdown());
      await hypervisor.shutdown();
    }
  });
}

test("Node shutdown releases an accepted WebSocket budget once", async () => {
  const budget = createConnectionBudget(1);
  const hypervisor = createHypervisor({
    transports: [{ type: "websocket", config: { path: "/workers" } }],
    admit: () => {
      throw new Error("no Hello expected");
    },
  });
  const listener = await serve({ hypervisor, budget });
  const url = new URL("/workers", listener.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, WORKER_PROTOCOL);
  const peerClosed = new Promise<void>((resolve) =>
    socket.addEventListener("close", () => resolve(), { once: true }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    assert.equal(budget.snapshot().connections, 1);
    await listener.shutdown();
    await peerClosed;
    assert.equal(budget.snapshot().connections, 0);
    await listener.shutdown();
    const lease = budget.connect();
    lease.release();
    assert.equal(budget.snapshot().connections, 0);
  } finally {
    socket.close();
    await listener.shutdown();
    await hypervisor.shutdown();
  }
});

async function upgradeResponse(port: number): Promise<
  Readonly<{
    statusLine: string;
    headers: Map<string, string[]>;
    body: Buffer;
  }>
> {
  const bytes = await requestBytes(port);
  const separator = bytes.indexOf("\r\n\r\n");
  assert.notEqual(separator, -1, "response must include the header terminator");
  const [statusLine, ...lines] = bytes
    .subarray(0, separator)
    .toString("latin1")
    .split("\r\n");
  const headers = new Map<string, string[]>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `invalid header: ${line}`);
    const name = line.slice(0, colon).toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
  }
  return {
    statusLine: statusLine!,
    headers,
    body: bytes.subarray(separator + 4),
  };
}

function requestBytes(port: number, upgrade = true): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy(new Error("upgrade response did not close"));
    }, 2_000);
    socket.once("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\nHost: localhost\r\n" +
          (upgrade
            ? "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            : "Connection: close\r\n") +
          "\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks)));
    socket.once("close", () => clearTimeout(timer));
  });
}
