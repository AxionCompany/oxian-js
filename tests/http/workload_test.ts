import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects } from "../support/assert.ts";
import {
  createHttpWorkload,
  decodeHttpResponseMetadata,
  encodeHttpRequestMetadata,
  HTTP_REQUEST_METADATA_SCHEMA,
  HTTP_WORKLOAD,
} from "../../src/http/index.ts";
import type { JsonObject } from "../../src/protocol/types.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import type {
  WorkerWorkContext,
  WorkerWorkResult,
} from "../../src/worker/types.ts";
import { concat, readChunks, streamOf } from "./test_utils.ts";

function context(
  metadata: JsonObject,
  input: ReadableStream<Uint8Array> = streamOf(),
  signal: AbortSignal = new AbortController().signal,
): WorkerWorkContext {
  return Object.freeze({
    streamId: "00000000-0000-4000-8000-000000000001",
    workload: HTTP_WORKLOAD,
    metadata,
    input,
    signal,
    sendMetadata: () => Promise.resolve(),
    callHost: () =>
      Promise.reject(new Error("host calls not configured in this fixture")),
  });
}

function resultObject(result: WorkerWorkResult): Readonly<{
  metadata?: JsonObject;
  body?: Uint8Array | ReadableStream<Uint8Array> | null;
}> {
  if (
    result === undefined ||
    result instanceof Uint8Array ||
    result instanceof ReadableStream
  ) {
    throw new TypeError("expected an HTTP workload result object");
  }
  return result;
}

test("HTTP workload reconstructs Request and streams binary Response", async () => {
  const limit = WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
  const requestBytes = new Uint8Array([0, 1, 255, 2]);
  const responseBytes = new Uint8Array(limit + 19);
  for (let index = 0; index < responseBytes.length; index++) {
    responseBytes[index] = index % 241;
  }
  const request = new Request("https://worker.test/upload?q=1", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-request": "yes",
    },
    body: new Uint8Array([1]),
  });
  const requestMetadata = encodeHttpRequestMetadata(request, "request-1");
  let observedRequest: Request | undefined;
  const workload = createHttpWorkload({
    fetch: async (incoming) => {
      observedRequest = incoming;
      assert.deepStrictEqual(
        new Uint8Array(await incoming.arrayBuffer()),
        requestBytes,
      );
      const headers = new Headers({
        "content-type": "application/octet-stream",
      });
      headers.append("set-cookie", "first=1; Path=/");
      headers.append("set-cookie", "second=2; Path=/");
      return new Response(streamOf(responseBytes), {
        status: 201,
        statusText: "Created",
        headers,
      });
    },
  });

  const result = resultObject(
    await workload(context(requestMetadata, streamOf(requestBytes))),
  );
  assert.deepStrictEqual(observedRequest?.method, "POST");
  assert.deepStrictEqual(
    observedRequest?.url,
    "https://worker.test/upload?q=1",
  );
  assert.deepStrictEqual(observedRequest?.headers.get("x-request"), "yes");
  const responseMetadata = decodeHttpResponseMetadata(result.metadata!);
  assert.deepStrictEqual(responseMetadata.status, 201);
  assert.deepStrictEqual(responseMetadata.statusText, "Created");
  assert.deepStrictEqual(responseMetadata.hasBody, true);
  assert.deepStrictEqual(
    responseMetadata.headers.filter(([name]) => name === "set-cookie"),
    [
      ["set-cookie", "first=1; Path=/"],
      ["set-cookie", "second=2; Path=/"],
    ],
  );
  const chunks = await readChunks(result.body as ReadableStream<Uint8Array>);
  assert.deepStrictEqual(
    chunks.every((chunk) => chunk.byteLength <= limit),
    true,
  );
  assert.deepStrictEqual(concat(chunks), responseBytes);
});

test("HTTP workload maps context cancellation to Request.signal", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const workload = createHttpWorkload({
    fetch: (request) => {
      observedSignal = request.signal;
      return new Response(null);
    },
  });
  const metadata = encodeHttpRequestMetadata(
    new Request("https://worker.test/"),
    "request-1",
  );

  await workload(context(metadata, streamOf(), controller.signal));
  controller.abort("operation_cancelled");
  assert.deepStrictEqual(observedSignal?.aborted, true);
  assert.deepStrictEqual(observedSignal?.reason, "operation_cancelled");
});

test("HTTP workload strips and cancels a HEAD response body", async () => {
  let cancellationReason: unknown;
  const responseBody = new ReadableStream<Uint8Array>(
    {
      cancel(reason) {
        cancellationReason = reason;
      },
    },
    { highWaterMark: 0 },
  );
  const workload = createHttpWorkload({
    fetch: () => new Response(responseBody),
  });
  const metadata = encodeHttpRequestMetadata(
    new Request("https://worker.test/", { method: "HEAD" }),
    "request-1",
  );

  const result = resultObject(await workload(context(metadata)));
  assert.deepStrictEqual(result.body, undefined);
  assert.deepStrictEqual(
    decodeHttpResponseMetadata(result.metadata!).hasBody,
    false,
  );
  await Promise.resolve();
  assert.deepStrictEqual(cancellationReason, "http_response_body_not_allowed");
});

test("HTTP workload keeps execution active until HEAD body cancellation settles", async () => {
  const cancellationStarted = Promise.withResolvers<void>();
  const releaseCancellation = Promise.withResolvers<void>();
  let resultSettled = false;
  const responseBody = new ReadableStream<Uint8Array>(
    {
      async cancel() {
        cancellationStarted.resolve();
        await releaseCancellation.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const workload = createHttpWorkload({
    fetch: () => new Response(responseBody),
  });
  const metadata = encodeHttpRequestMetadata(
    new Request("https://worker.test/", { method: "HEAD" }),
    "request-1",
  );

  const resultPromise = Promise.resolve(workload(context(metadata))).finally(
    () => {
      resultSettled = true;
    },
  );
  await cancellationStarted.promise;
  await Promise.resolve();
  assert.deepStrictEqual(resultSettled, false);

  releaseCancellation.resolve();
  const result = resultObject(await resultPromise);
  assert.deepStrictEqual(resultSettled, true);
  assert.deepStrictEqual(
    decodeHttpResponseMetadata(result.metadata!).hasBody,
    false,
  );
});

test("HTTP workload rejects malformed metadata before fetch", async () => {
  let calls = 0;
  const workload = createHttpWorkload({
    fetch: () => {
      calls++;
      return new Response(null);
    },
  });

  await assertRejects(
    async () =>
      await workload(
        context({
          schema: HTTP_REQUEST_METADATA_SCHEMA,
          requestId: "request-1",
          method: "POST",
          url: "not-an-absolute-url",
          headers: [],
          hasBody: false,
        }),
      ),
    TypeError,
    "expected an absolute URL",
  );
  assert.deepStrictEqual(calls, 0);
});

test("HTTP workload requires a native Response", async () => {
  const workload = createHttpWorkload({
    fetch: () => "not a response" as unknown as Response,
  });
  const metadata = encodeHttpRequestMetadata(
    new Request("https://worker.test/"),
    "request-1",
  );

  await assertRejects(
    async () => await workload(context(metadata)),
    TypeError,
    "must return a Response",
  );
});
