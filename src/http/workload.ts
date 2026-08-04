import type { WorkerWorkHandler } from "../worker/types.ts";
import { rechunkHttpBody } from "./body.ts";
import {
  createHeaders,
  decodeHttpRequestMetadata,
  encodeHttpResponseMetadata,
} from "./metadata.ts";
import type {
  HttpRequestMetadata,
  HttpResponseMetadata,
  HttpWorkloadOptions,
} from "./types.ts";

export function createHttpWorkload(
  options: HttpWorkloadOptions,
): WorkerWorkHandler {
  if (typeof options?.fetch !== "function") {
    throw new TypeError("HTTP workload fetch must be a function");
  }

  const workload: WorkerWorkHandler = async (context) => {
    let metadata: HttpRequestMetadata;
    try {
      metadata = decodeHttpRequestMetadata(context.metadata);
    } catch (error) {
      await context.input.cancel(error).catch(() => undefined);
      throw error;
    }
    const input = metadata.hasBody ? rechunkHttpBody(context.input) : undefined;
    let request: Request;
    try {
      request = new Request(metadata.url, {
        method: metadata.method,
        headers: createHeaders(metadata.headers),
        ...(input === undefined
          ? {}
          : { body: input, duplex: "half" as const }),
        signal: context.signal,
      });
    } catch (error) {
      await input?.cancel(error).catch(() => undefined);
      throw error;
    }

    const response = await options.fetch(request);
    if (!(response instanceof Response)) {
      throw new TypeError("HTTP workload fetch must return a Response");
    }
    const hasBody = request.method !== "HEAD" && response.body !== null;
    let responseMetadata: HttpResponseMetadata;
    try {
      responseMetadata = encodeHttpResponseMetadata(response, {
        hasBody,
      });
    } catch (error) {
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    if (!hasBody) {
      if (response.body !== null) {
        await response.body.cancel("http_response_body_not_allowed").catch(
          () => undefined,
        );
      }
      return Object.freeze({ metadata: responseMetadata });
    }
    return Object.freeze({
      metadata: responseMetadata,
      body: rechunkHttpBody(response.body!),
    });
  };

  return Object.freeze(workload);
}
