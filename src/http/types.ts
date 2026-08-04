import type {
  WorkerHostDispatchInput,
  WorkerHostWorkHandle,
} from "../host/types.ts";
import type { JsonObject } from "../protocol/types.ts";

export const HTTP_REQUEST_METADATA_SCHEMA = "oxian.http.request.v1" as const;
export const HTTP_RESPONSE_METADATA_SCHEMA = "oxian.http.response.v1" as const;
export const HTTP_WORKLOAD = "oxian.http.v1" as const;

export type HttpHeaderPair = readonly [name: string, value: string];

export type HttpRequestMetadata =
  & JsonObject
  & Readonly<{
    schema: typeof HTTP_REQUEST_METADATA_SCHEMA;
    requestId: string;
    method: string;
    url: string;
    headers: readonly HttpHeaderPair[];
    hasBody: boolean;
  }>;

export type HttpResponseMetadata =
  & JsonObject
  & Readonly<{
    schema: typeof HTTP_RESPONSE_METADATA_SCHEMA;
    status: number;
    statusText: string;
    headers: readonly HttpHeaderPair[];
    hasBody: boolean;
  }>;

export type HttpDispatch = (
  input: WorkerHostDispatchInput,
) => Promise<WorkerHostWorkHandle>;

export type HttpGatewayDeadline = (
  request: Request,
) => number | undefined;

export type HttpGatewayOptions = Readonly<{
  dispatch: HttpDispatch;
  workload?: string;
  createRequestId?: () => string;
  deadlineAtMs?: HttpGatewayDeadline;
}>;

export type HttpGateway = (
  request: Request,
) => Promise<Response>;

export type HttpFetchHandler = (
  request: Request,
) => Response | Promise<Response>;

export type HttpWorkloadOptions = Readonly<{
  fetch: HttpFetchHandler;
}>;
