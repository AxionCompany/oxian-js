import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRouteWebSocket,
  ROUTE_WEBSOCKET_LIMITS,
  upgradeWebSocket,
} from "./websocket.ts";
import { decodeHttpResponseMetadata } from "./metadata.ts";
import {
  decodeUpgradeAcceptance,
  decodeUpgradeRequest,
} from "./upgrade-metadata.ts";

function request(): Request {
  return new Request("https://example.test/echo", {
    headers: { upgrade: "websocket" },
  });
}
function frame(type: number, bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + bytes.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, bytes.length);
  frame.set(bytes, 5);
  return frame;
}
function input(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("route decoder preserves text, binary and close across arbitrary work chunks", async () => {
  const socket = createRouteWebSocket(request(), "");
  const events: unknown[] = [];
  socket.onmessage = (event) => events.push(event.data);
  socket.onclose = (event) => events.push([event.code, event.reason]);
  socket.activate();
  const text = frame(1, new TextEncoder().encode("text €"));
  const binary = frame(2, new Uint8Array([0, 255]));
  const close = frame(8, new Uint8Array([15, 162, 98, 121, 101])); // 4002, bye
  const bytes = new Uint8Array([...text, ...binary, ...close]);
  await socket.receive(
    input(...[...bytes].map((byte) => new Uint8Array([byte]))),
  );
  assert.equal(events[0], "text €");
  assert.deepEqual([...new Uint8Array(events[1] as ArrayBuffer)], [0, 255]);
  assert.deepEqual(events[2], [4002, "bye"]);
});

for (const kind of ["declared-size", "utf8", "opcode", "close", "eof"] as const)
  test(`route decoder rejects ${kind}`, async () => {
    const socket = createRouteWebSocket(request(), "");
    let code = 0;
    socket.onclose = (event) => {
      code = event.code;
    };
    socket.activate();
    const oversized = new Uint8Array(5);
    oversized[0] = 2;
    new DataView(oversized.buffer).setUint32(
      1,
      ROUTE_WEBSOCKET_LIMITS.messageBytes + 1,
    );
    const bytes =
      kind === "declared-size"
        ? oversized
        : kind === "utf8"
          ? frame(1, new Uint8Array([255]))
          : kind === "opcode"
            ? frame(3, new Uint8Array())
            : kind === "close"
              ? frame(8, new Uint8Array([3, 238]))
              : new Uint8Array();
    await socket.receive(input(bytes));
    assert.equal(code, kind === "declared-size" ? 1009 : 1011);
  });

for (const kind of ["message", "bytes", "count"] as const)
  test(`route output bounds ${kind} without a reader`, () => {
    const socket = createRouteWebSocket(request(), "");
    socket.activate();
    let code = 0;
    socket.onclose = (event) => {
      code = event.code;
    };
    if (kind === "message")
      socket.send(new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes + 1));
    if (kind === "bytes")
      for (let i = 0; i < 4; i++)
        socket.send(new Uint8Array(ROUTE_WEBSOCKET_LIMITS.messageBytes));
    if (kind === "count") for (let i = 0; i < 65; i++) socket.send("");
    assert.equal(code, 1009);
    assert.ok(socket.bufferedAmount <= 130);
  });

test("native send buffering is bounded", async () => {
  const socket = createRouteWebSocket(request(), "");
  let code = 0,
    sent = false;
  socket.attach({
    state: "open",
    protocol: "",
    bufferedAmount: ROUTE_WEBSOCKET_LIMITS.queuedBytes,
    send() {
      sent = true;
    },
    close(value) {
      code = value!;
    },
    subscribe() {
      return () => undefined;
    },
  });
  await socket.receive(input(frame(1, new TextEncoder().encode("overflow"))));
  assert.equal(sent, false);
  assert.equal(code, 1009);
});

test("ordinary HTTP stays strict and acceptance metadata cannot be synthesized from HTTP 101", () => {
  assert.throws(
    () =>
      decodeHttpResponseMetadata({
        schema: "oxian.http.response.v1",
        status: 101,
        statusText: "",
        headers: [],
        hasBody: false,
      }),
    /between 200 and 599/,
  );
  assert.throws(
    () => upgradeWebSocket(new Request("https://example.test/")),
    /upgrade request/,
  );
  assert.throws(
    () => upgradeWebSocket(request(), { protocol: "unoffered" }),
    /not offered/,
  );
  assert.throws(
    () =>
      decodeUpgradeAcceptance({
        schema: "oxian.websocket.accept.v1",
        protocol: "a,b",
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      decodeUpgradeAcceptance({
        schema: "oxian.websocket.accept.v1",
        protocol: "",
        status: 101,
      }),
    /Invalid/,
  );
  assert.throws(
    () =>
      decodeUpgradeRequest({
        schema: "oxian.websocket.request.v1",
        request: {},
        clientAddress: 12,
      }),
    /Invalid/,
  );
});

test("output cancellation preserves the peer close waiting in the other half", async () => {
  const controller = new AbortController();
  const socket = createRouteWebSocket(
    new Request(request(), { signal: controller.signal }),
    "",
  );
  socket.activate();
  await socket.output.cancel();
  assert.throws(() => socket.send("after EOF"), /not open/);
  let code = 0;
  socket.onclose = (event) => {
    code = event.code;
  };
  await socket.receive(input(frame(8, new Uint8Array([15, 162]))));
  assert.equal(code, 4002);
  controller.abort();
  assert.equal(socket.readyState, 3);
});

test("a failure while the native handshake opens sends its close after open", () => {
  const socket = createRouteWebSocket(request(), "");
  let observer: import("../transport/types.ts").SocketObserver | undefined;
  let code = 0;
  socket.attach({
    state: "connecting",
    protocol: "",
    bufferedAmount: 0,
    subscribe(value) {
      observer = value;
      return () => undefined;
    },
    send() {
      assert.fail("unexpected send");
    },
    close(value) {
      code = value!;
    },
  });
  socket.fail();
  assert.equal(code, 0);
  observer!.open!();
  assert.equal(code, 1011);
});
