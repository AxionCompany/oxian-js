import assert from "node:assert/strict";
import { connect as connectTcp } from "node:net";
import { test } from "node:test";
import { createHypervisor } from "../../hypervisor/hypervisor.ts";
import { serve } from "./server.ts";

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
