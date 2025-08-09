import type { Context, Handler } from "../core/types.ts";
import { OxianHttpError } from "../core/types.ts";
import type { ResponseState } from "../utils/response.ts";

function toHttpResponse(result: unknown, state: ResponseState): void {
  if (state.body !== undefined) return;
  if (result === undefined) {
    return;
  }
  if (typeof result === "string" || result instanceof Uint8Array) {
    state.body = result;
    return;
  }
  state.body = result;
}

export function shapeError(err: unknown): { status: number; body: unknown } {
  if (err && typeof err === "object" && "message" in err) {
    const anyErr = err as Record<string, unknown>;
    const statusCode = typeof anyErr.statusCode === "number" ? anyErr.statusCode : undefined;
    if (statusCode) {
      return { status: statusCode, body: { error: (anyErr.message as string) ?? "Error" } };
    }
  }
  if (err instanceof OxianHttpError) {
    return { status: err.statusCode, body: { error: { message: err.message, code: err.code, details: err.details } } };
  }
  if (Deno.env.get("OXIAN_DEBUG") === "1") {
    const e = err as Error;
    return { status: 500, body: { error: { message: e?.message ?? "Internal Server Error", stack: e?.stack } } };
  }
  return { status: 500, body: { error: { message: "Internal Server Error" } } };
}

export async function runHandler(
  handler: Handler,
  data: Record<string, unknown>,
  context: Context,
  state: ResponseState,
): Promise<{ result?: unknown; error?: unknown }> {
  const isStreaming = () => state.body && typeof (state.body as any).getReader === "function";
  try {
    const maybePromise = handler(data, context);
    if (isStreaming() && typeof (maybePromise as any)?.then === "function") {
      (maybePromise as Promise<unknown>)
        .then((result) => {
          // If handler returned a value, write it as the last chunk and close
          if (result !== undefined && state.streamWrite) {
            if (typeof result === "string" || result instanceof Uint8Array) {
              state.streamWrite(result);
            } else {
              state.streamWrite(JSON.stringify(result));
            }
          }
          state.streamClose?.();
        })
        .catch((err) => {
          const shaped = shapeError(err);
          if (state.streamWrite) {
            state.streamWrite(typeof shaped.body === "string" ? shaped.body : JSON.stringify(shaped.body));
          }
          state.streamClose?.();
        });
      return { result: undefined };
    }
    const result = await maybePromise;
    toHttpResponse(result, state);
    return { result };
  } catch (err) {
    const shaped = shapeError(err);
    if (isStreaming()) {
      if (state.streamWrite) {
        state.streamWrite(typeof shaped.body === "string" ? shaped.body : JSON.stringify(shaped.body));
      }
      state.streamClose?.();
    } else {
      state.status = shaped.status;
      state.body = shaped.body;
    }
    return { error: err };
  }
} 