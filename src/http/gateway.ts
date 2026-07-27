import type { JsonObject } from "../protocol/types.ts";
import { rechunkHttpBody } from "./body.ts";
import {
  createHeaders,
  decodeHttpResponseMetadata,
  encodeHttpRequestMetadata,
} from "./metadata.ts";
import type {
  HttpGateway,
  HttpGatewayOptions,
  HttpResponseMetadata,
} from "./types.ts";
import { HTTP_WORKLOAD } from "./types.ts";

const WORKLOAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function validateWorkload(value: string): string {
  if (
    value.length < 1 ||
    value.length > 128 ||
    !WORKLOAD_PATTERN.test(value)
  ) {
    throw new TypeError(
      "HTTP gateway workload must be a valid Oxian workload identifier",
    );
  }
  return value;
}

function validateDeadline(value: number | undefined): number | undefined {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError(
      "HTTP gateway deadlineAtMs must return a non-negative safe integer",
    );
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ??
    new DOMException("HTTP request was aborted", "AbortError");
}

function cancellationMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.slice(0, 512);
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.slice(0, 512);
  }
  return "http_gateway_cancelled";
}

function waitForMetadata(
  metadata: Promise<JsonObject>,
  signal: AbortSignal,
  cancel: (reason: string) => void,
): Promise<JsonObject> {
  if (signal.aborted) {
    const reason = abortReason(signal);
    cancel(cancellationMessage(reason));
    return Promise.reject(reason);
  }
  return new Promise<JsonObject>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const abort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = abortReason(signal);
      cancel(cancellationMessage(reason));
      reject(reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    metadata.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function verifyExpectedEmptyOutput(
  output: ReadableStream<Uint8Array>,
  cancel: (reason: string) => void,
): void {
  void (async () => {
    const reader = output.getReader();
    try {
      const first = await reader.read();
      if (!first.done) cancel("unexpected_http_response_body");
    } catch {
      // The operation lifecycle owns transport errors after the Response exists.
    } finally {
      reader.releaseLock();
    }
  })();
}

export function createHttpGateway(
  options: HttpGatewayOptions,
): HttpGateway {
  if (typeof options?.dispatch !== "function") {
    throw new TypeError("HTTP gateway dispatch must be a function");
  }
  if (
    options.createRequestId !== undefined &&
    typeof options.createRequestId !== "function"
  ) {
    throw new TypeError("HTTP gateway createRequestId must be a function");
  }
  if (
    options.deadlineAtMs !== undefined &&
    typeof options.deadlineAtMs !== "function"
  ) {
    throw new TypeError("HTTP gateway deadlineAtMs must be a function");
  }
  const workload = validateWorkload(
    options.workload ?? HTTP_WORKLOAD,
  );
  const createRequestId = options.createRequestId ??
    (() => crypto.randomUUID());

  const gateway: HttpGateway = async (request) => {
    if (!(request instanceof Request)) {
      throw new TypeError("HTTP gateway expects a Request");
    }
    request.signal.throwIfAborted();
    const metadata = encodeHttpRequestMetadata(request, createRequestId());
    const deadlineAtMs = validateDeadline(
      options.deadlineAtMs?.(request),
    );
    const body = request.body === null
      ? undefined
      : rechunkHttpBody(request.body);
    let handle;
    try {
      handle = await options.dispatch({
        workload,
        metadata,
        ...(body === undefined ? {} : { body }),
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
        signal: request.signal,
      });
    } catch (error) {
      void body?.cancel(error).catch(() => undefined);
      throw error;
    }

    const cancel = (reason: string): void => {
      void handle.cancel(reason).catch(() => undefined);
    };
    const rawResponseMetadata = await waitForMetadata(
      handle.metadata,
      request.signal,
      cancel,
    );
    let responseMetadata: HttpResponseMetadata;
    try {
      responseMetadata = decodeHttpResponseMetadata(
        rawResponseMetadata,
      );
    } catch (error) {
      cancel("invalid_http_response_metadata");
      throw error;
    }

    const responseBody = responseMetadata.hasBody
      ? rechunkHttpBody(handle.output)
      : null;
    if (!responseMetadata.hasBody) {
      verifyExpectedEmptyOutput(handle.output, cancel);
    }
    try {
      return new Response(responseBody, {
        status: responseMetadata.status,
        statusText: responseMetadata.statusText,
        headers: createHeaders(responseMetadata.headers),
      });
    } catch (error) {
      if (responseBody !== null) {
        void responseBody.cancel(error).catch(() => undefined);
      }
      cancel("invalid_http_response");
      throw error;
    }
  };

  return Object.freeze(gateway);
}
