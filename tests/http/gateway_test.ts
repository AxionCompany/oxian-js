import { assertEquals, assertRejects } from "@std/assert";
import type { HypervisorDispatchInput } from "../../src/hypervisor/types.ts";
import {
  createHttpGateway,
  decodeHttpRequestMetadata,
  encodeHttpResponseMetadata,
  HTTP_RESPONSE_METADATA_SCHEMA,
  HTTP_WORKLOAD,
} from "../../src/http/index.ts";
import type { JsonObject } from "../../src/protocol/types.ts";
import { WORKER_PROTOCOL_LIMITS } from "../../src/protocol/limits.ts";
import {
  concat,
  createDeferred,
  createHandle,
  readChunks,
  streamOf,
} from "./test_utils.ts";

Deno.test("HTTP gateway defaults to the versioned HTTP workload", async () => {
  let workload: string | undefined;
  const gateway = createHttpGateway({
    dispatch: (input) => {
      workload = input.workload;
      return Promise.resolve(createHandle({
        metadata: encodeHttpResponseMetadata(new Response(null)),
      }));
    },
  });

  await gateway(new Request("https://gateway.test/"));
  assertEquals(workload, HTTP_WORKLOAD);
});

Deno.test("HTTP gateway maps request and streaming response without buffering", async () => {
  const limit = WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
  const requestBytes = new Uint8Array(limit + 23);
  requestBytes.fill(7);
  const responseBytes = new Uint8Array([0, 255, 1, 128, 2]);
  const responseHeaders = new Headers();
  responseHeaders.append("set-cookie", "first=1; Path=/");
  responseHeaders.append("set-cookie", "second=2; Path=/");
  responseHeaders.append("content-type", "application/octet-stream");
  const responseMetadata = encodeHttpResponseMetadata(
    new Response(responseBytes, {
      status: 201,
      statusText: "Created",
      headers: responseHeaders,
    }),
  );
  let dispatched: HypervisorDispatchInput | undefined;
  const gateway = createHttpGateway({
    workload: "http.api",
    createRequestId: () => "request-fixed",
    deadlineAtMs: () => 123_456,
    dispatch: (input) => {
      dispatched = input;
      return Promise.resolve(createHandle({
        metadata: responseMetadata,
        output: streamOf(responseBytes),
      }));
    },
  });

  const request = new Request("https://gateway.test/v1/items?q=1", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-client": "test",
    },
    body: streamOf(requestBytes),
  });
  const response = await gateway(request);

  assertEquals(response.status, 201);
  assertEquals(response.statusText, "Created");
  assertEquals(response.headers.getSetCookie(), [
    "first=1; Path=/",
    "second=2; Path=/",
  ]);
  assertEquals(new Uint8Array(await response.arrayBuffer()), responseBytes);
  assertEquals(dispatched?.workload, "http.api");
  assertEquals(dispatched?.deadlineAtMs, 123_456);
  assertEquals(dispatched?.signal, request.signal);
  const requestMetadata = decodeHttpRequestMetadata(dispatched!.metadata!);
  assertEquals(requestMetadata.requestId, "request-fixed");
  assertEquals(requestMetadata.method, "POST");
  assertEquals(requestMetadata.url, "https://gateway.test/v1/items?q=1");
  assertEquals(requestMetadata.hasBody, true);
  const requestChunks = await readChunks(
    dispatched!.body as ReadableStream<Uint8Array>,
  );
  assertEquals(
    requestChunks.every((chunk) => chunk.byteLength <= limit),
    true,
  );
  assertEquals(concat(requestChunks), requestBytes);
});

Deno.test("HTTP gateway maps request abort while awaiting metadata", async () => {
  const metadata = createDeferred<JsonObject>();
  const cancellation = createDeferred<string | undefined>();
  const controller = new AbortController();
  const gateway = createHttpGateway({
    dispatch: () =>
      Promise.resolve(createHandle({
        metadata: metadata.promise,
        cancel: cancellation.resolve,
      })),
  });
  const operation = gateway(
    new Request("https://gateway.test/", {
      signal: controller.signal,
    }),
  );
  await Promise.resolve();
  controller.abort(new DOMException("browser disconnected", "AbortError"));

  await assertRejects(
    () => operation,
    DOMException,
    "browser disconnected",
  );
  assertEquals(await cancellation.promise, "browser disconnected");
});

Deno.test("HTTP gateway cancels a malformed worker response", async () => {
  const cancellations: (string | undefined)[] = [];
  const gateway = createHttpGateway({
    dispatch: () =>
      Promise.resolve(createHandle({
        metadata: {
          schema: HTTP_RESPONSE_METADATA_SCHEMA,
          status: 200,
          statusText: "OK",
          headers: [],
          hasBody: true,
          extra: "not allowed",
        },
        cancel: (reason) => cancellations.push(reason),
      })),
  });

  await assertRejects(
    () => gateway(new Request("https://gateway.test/")),
    TypeError,
    "unexpected field extra",
  );
  assertEquals(cancellations, ["invalid_http_response_metadata"]);
});

Deno.test("HTTP gateway propagates response-body cancellation", async () => {
  let cancelledWith: unknown;
  const metadata = encodeHttpResponseMetadata(
    new Response(new Uint8Array([1])),
  );
  const output = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelledWith = reason;
    },
  }, { highWaterMark: 0 });
  const gateway = createHttpGateway({
    dispatch: () =>
      Promise.resolve(createHandle({
        metadata,
        output,
      })),
  });

  const response = await gateway(new Request("https://gateway.test/"));
  await response.body!.cancel("client_disconnected");
  assertEquals(cancelledWith, "client_disconnected");
});

Deno.test("HTTP gateway cancels an unread request body when dispatch fails", async () => {
  let cancelledWith: unknown;
  const requestBody = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelledWith = reason;
    },
  }, { highWaterMark: 0 });
  const failure = new Error("no worker available");
  const gateway = createHttpGateway({
    dispatch: () => Promise.reject(failure),
  });

  await assertRejects(
    () =>
      gateway(
        new Request("https://gateway.test/", {
          method: "POST",
          body: requestBody,
        }),
      ),
    Error,
    "no worker available",
  );
  assertEquals(cancelledWith, failure);
});
