import type { JsonObject } from "../protocol/types.ts";
import {
  decodeHttpRequestMetadata,
  encodeHttpRequestMetadata,
} from "./metadata.ts";
import { getClientAddress } from "./websocket.ts";

export const UPGRADE_REQUEST_SCHEMA = "oxian.websocket.request.v1";
export const UPGRADE_RESPONSE_SCHEMA = "oxian.websocket.accept.v1";

export function upgradeRequestMetadata(
  request: Request,
  id: string,
): JsonObject {
  return {
    schema: UPGRADE_REQUEST_SCHEMA,
    request: encodeHttpRequestMetadata(request, id),
    clientAddress: getClientAddress(request) ?? null,
  };
}

export function decodeUpgradeRequest(value: JsonObject) {
  if (
    Object.keys(value).sort().join(",") !== "clientAddress,request,schema" ||
    value.schema !== UPGRADE_REQUEST_SCHEMA ||
    !(
      value.clientAddress === null ||
      (typeof value.clientAddress === "string" &&
        value.clientAddress.length <= 256)
    )
  ) {
    throw new TypeError("Invalid WebSocket request metadata");
  }
  const request = decodeHttpRequestMetadata(value.request as JsonObject);
  if (
    request.method !== "GET" ||
    request.hasBody ||
    new Headers(request.headers as [string, string][])
      .get("upgrade")
      ?.toLowerCase() !== "websocket"
  ) {
    throw new TypeError("WebSocket metadata requires an upgrade request");
  }
  return { request, clientAddress: value.clientAddress };
}

export function decodeUpgradeAcceptance(value: JsonObject): string {
  if (
    Object.keys(value).sort().join(",") !== "protocol,schema" ||
    value.schema !== UPGRADE_RESPONSE_SCHEMA ||
    typeof value.protocol !== "string" ||
    value.protocol.length > 256 ||
    (value.protocol !== "" &&
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value.protocol))
  ) {
    throw new TypeError("Invalid WebSocket acceptance metadata");
  }
  return value.protocol;
}
