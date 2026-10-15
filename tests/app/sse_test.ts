import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../support/assert.ts";
import { createServerSentEvents } from "../../src/app/sse.ts";

test("SSE publishes the first event before a reader starts", async () => {
  const events = createServerSentEvents();
  await events.send("hello", {
    id: "one",
    event: "message",
    retry: 250,
  });

  const reader = events.response.body!.getReader();
  const first = await reader.read();
  assert.ok(!first.done);
  assert.deepStrictEqual(
    new TextDecoder().decode(first.value),
    "id: one\nevent: message\nretry: 250\ndata: hello\n\n",
  );
  await events.close();
  assert.deepStrictEqual((await reader.read()).done, true);
  await events.closed;
});

test("SSE preserves multiline data and serializes concurrent writes", async () => {
  const events = createServerSentEvents({ bufferBytes: 1024 });
  const first = events.send("a\nb");
  const second = events.comment("still\nhere");
  await Promise.all([first, second]);
  await events.close();

  assert.deepStrictEqual(
    await events.response.text(),
    "data: a\ndata: b\n\n:still\n:here\n\n",
  );
});

test("SSE cancellation and AbortSignal settle the writer", async () => {
  const controller = new AbortController();
  const events = createServerSentEvents({ signal: controller.signal });
  await events.send({ ok: true });
  controller.abort("request_disconnected");
  await events.closed;
  await assertRejects(() => events.send("late"), TypeError, "closed");
});

test("SSE validates line fields and maximum event size", async () => {
  const events = createServerSentEvents({ maxEventBytes: 16 });
  await assertRejects(
    () => events.send("ok", { event: "bad\nname" }),
    TypeError,
    "newline",
  );
  await assertRejects(
    () => events.send("this event is too large"),
    TypeError,
    "exceeds",
  );
  await events.abort();
});

test("SSE abort preempts a backpressured close", async () => {
  const events = createServerSentEvents({ bufferBytes: 1 });
  await events.send("first");
  const blockedSend = events.send("second");
  const closing = events.close();
  const aborting = events.abort("request_disconnected");

  await aborting;
  await closing;
  await assertRejects(() => blockedSend);
  await events.closed;
});

test("SSE validates response options before allocating a stream", async () => {
  assertThrows(
    () => createServerSentEvents({ status: 204 }),
    TypeError,
    "body-compatible",
  );
  assertThrows(
    () => createServerSentEvents({ retry: -1 }),
    TypeError,
    "non-negative",
  );

  const events = createServerSentEvents({
    headers: {
      "content-length": "12",
      "transfer-encoding": "chunked",
    },
  });
  assert.deepStrictEqual(events.response.headers.has("content-length"), false);
  assert.deepStrictEqual(
    events.response.headers.has("transfer-encoding"),
    false,
  );
  await events.abort();
});
