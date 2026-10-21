import {
  decodeUpgradeRequest,
  UPGRADE_REQUEST_SCHEMA,
  UPGRADE_RESPONSE_SCHEMA,
} from "./upgrade-metadata.ts";
import { acceptedWebSocket, setClientAddress } from "./websocket.ts";
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
      metadata =
        context.metadata.schema === UPGRADE_REQUEST_SCHEMA
          ? decodeUpgradeRequest(context.metadata).request
          : decodeHttpRequestMetadata(context.metadata);
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

    if (context.metadata.schema === UPGRADE_REQUEST_SCHEMA) {
      const address = decodeUpgradeRequest(context.metadata).clientAddress;
      if (typeof address === "string") setClientAddress(request, address);
    }
    const response =
      context.metadata.schema === UPGRADE_REQUEST_SCHEMA &&
      options.hostWebSocket
        ? await options.hostWebSocket(request, options.fetch)
        : await options.fetch(request);
    const socket = acceptedWebSocket(response);
    if (socket) {
      if (
        context.metadata.schema !== UPGRADE_REQUEST_SCHEMA ||
        (!options.hostWebSocket && socket.request !== request)
      ) {
        socket.fail();
        throw new TypeError(
          "WebSocket acceptance does not belong to this request",
        );
      }
      socket.activate();
      void socket.receive(context.input);
      return {
        metadata: {
          schema: UPGRADE_RESPONSE_SCHEMA,
          protocol: socket.protocol,
        },
        body: socket.output,
      };
    }
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
        await response.body
          .cancel("http_response_body_not_allowed")
          .catch(() => undefined);
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
