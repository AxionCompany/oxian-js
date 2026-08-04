import { assertEquals, assertRejects } from "@std/assert";
import { rechunkHttpBody } from "../../src/http/index.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import { concat, readChunks } from "./test_utils.ts";

Deno.test("HTTP body rechunking stays within the protocol payload limit", async () => {
  const limit = WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
  const input = new Uint8Array(limit * 2 + 17);
  for (let index = 0; index < input.length; index++) input[index] = index % 251;

  const chunks = await readChunks(rechunkHttpBody(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      },
    }),
  ));

  assertEquals(chunks.map((chunk) => chunk.byteLength), [
    limit,
    limit,
    17,
  ]);
  assertEquals(concat(chunks), input);
});

Deno.test("HTTP body rechunking does not pull ahead of downstream demand", async () => {
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array([pulls]));
      if (pulls === 2) controller.close();
    },
  }, { highWaterMark: 0 });
  const body = rechunkHttpBody(source);
  const reader = body.getReader();

  assertEquals(pulls, 0);
  assertEquals(await reader.read(), {
    done: false,
    value: new Uint8Array([1]),
  });
  assertEquals(pulls, 1);
  assertEquals(await reader.read(), {
    done: false,
    value: new Uint8Array([2]),
  });
  assertEquals(pulls, 2);
  assertEquals(await reader.read(), { done: true, value: undefined });
  reader.releaseLock();
});

Deno.test("HTTP body cancellation reaches the upstream stream", async () => {
  let reason: unknown;
  const body = rechunkHttpBody(
    new ReadableStream<Uint8Array>({
      cancel(value) {
        reason = value;
      },
    }, { highWaterMark: 0 }),
  );

  await body.cancel("consumer_disconnected");
  assertEquals(reason, "consumer_disconnected");
});

Deno.test("HTTP body rejects non-binary chunks", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue("not bytes");
    },
  }) as unknown as ReadableStream<Uint8Array>;
  const reader = rechunkHttpBody(source).getReader();
  await assertRejects(
    () => reader.read(),
    TypeError,
    "must yield Uint8Array",
  );
});
