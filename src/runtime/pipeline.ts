import type { Context, Handler } from "../core/index.ts";
import { OxianHttpError } from "../core/index.ts";
import type { ResponseState } from "../server/types.ts";

function toHttpResponse(result: unknown, state: ResponseState): void {
  if (state.body !== undefined) return;
  if (result === undefined) {
    return;
  }
  // If a native Fetch API Response is returned, adopt its fields into state
  if (result instanceof Response) {
    state.status = result.status;
    state.statusText = result.statusText || state.statusText;
    // Merge headers from the Response, overriding existing keys
    for (const [k, v] of result.headers.entries()) {
      state.headers.set(k, v);
    }
    // If the Response has a body, forward it; otherwise keep body undefined
    if (result.body) {
      state.body = result.body;
    }
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
    const statusCode = typeof anyErr.statusCode === "number"
      ? anyErr.statusCode
      : (typeof (anyErr as { status?: unknown }).status === "number"
        ? (anyErr as { status?: number }).status
        : undefined);
    if (statusCode) {
      const msg = typeof anyErr.message === "string"
        ? anyErr.message
        : "Error";
      const code = typeof anyErr.code === "string" ? anyErr.code : undefined;
      const details = (anyErr as { details?: unknown }).details;
      return {
        status: statusCode,
        body: {
          error: {
            message: msg,
            ...(code ? { code } : {}),
            ...(details !== undefined ? { details } : {}),
          },
        },
      };
    }
  }
  if (err instanceof OxianHttpError) {
    return {
      status: err.statusCode,
      body: {
        error: { message: err.message, code: err.code, details: err.details },
      },
    };
  }
  console.error("[unhandled] Error", err);
  if (Deno.env.get("OXIAN_DEBUG") === "1") {
    const e = err as Error;
    return {
      status: 500,
      body: {
        error: {
          message: e?.message ?? "Internal Server Error",
          stack: e?.stack,
        },
      },
    };
  }
  return { status: 500, body: { error: { message: "Internal Server Error" } } };
}

async function callHandlerWithCompatibility(
  modExport: unknown,
  data: Record<string, unknown>,
  context: Context,
  _state: ResponseState,
  handlerMode: string | undefined,
): Promise<unknown> {
  if (handlerMode === "this") {
    console.warn(
      "[oxian] DEPRECATED: handlerMode 'this' is deprecated. Please migrate to (data, context)",
    );
    if (typeof modExport !== "function") {
      throw new Error("Invalid handler export");
    }
    const bound = (modExport as (this: unknown, ...args: unknown[]) => unknown)
      .bind({ ...context.dependencies, ...context.request });
    // provide (data, { response })
    return await bound(data, context.response);
  }
  if (handlerMode === "factory") {
    console.warn(
      "[oxian] DEPRECATED: handlerMode 'factory' is deprecated. Please migrate to (data, context)",
    );
    if (typeof modExport !== "function") {
      throw new Error("Invalid factory export");
    }
    const fn = (modExport as (deps: unknown) => unknown)(context.dependencies);
    if (typeof fn !== "function") {
      throw new Error("Factory did not return a function");
    }
    return await (fn as (
      data: Record<string, unknown>,
      ctx: { response: Context["response"] },
    ) => unknown)(data, { response: context.response });
  }
  // default:
  if (typeof modExport !== "function") {
    throw new Error("Invalid handler export");
  }
  return await (modExport as (
    data: Record<string, unknown>,
    context: Context,
  ) => unknown)(data, context);
}

export async function runHandler(
  handler: Handler,
  data: Record<string, unknown>,
  context: Context,
  state: ResponseState,
): Promise<{ result?: unknown; error?: unknown }> {
  const isStreaming = () =>
    state.body &&
    typeof (state.body as ReadableStream).getReader === "function";
  const isSse = () =>
    (state.headers.get("content-type") || "").startsWith("text/event-stream");

  let resolveSendSignal: (() => void) | undefined;
  const sendSignal = new Promise<void>((resolve) => {
    resolveSendSignal = resolve;
  });
  state.onSend = () => resolveSendSignal?.();
  if (state.responded) resolveSendSignal?.();

  try {
    // Determine compatibility mode from context (stored under oxian later if needed)
    const handlerMode =
      (context as unknown as { compat?: { handlerMode?: string } }).compat
        ?.handlerMode;
    const maybePromise = callHandlerWithCompatibility(
      handler as unknown as unknown,
      data,
      context,
      state,
      handlerMode,
    );
    const isThenable =
      typeof (maybePromise as Promise<unknown>)?.then === "function";

    if (state.responded && !isStreaming()) {
      if (isThenable) {
        Promise.resolve(maybePromise).catch((err) => {
          console.error(
            "[oxian] Handler rejected after response.send completed",
            err,
          );
        });
      }
      state.onSend = undefined;
      return { result: undefined };
    }

    if (isStreaming() && isThenable) {
      (maybePromise as Promise<unknown>)
        .then((result) => {
          if (isSse()) {
            if (result !== undefined && state.streamWrite) {
              const payload =
                typeof result === "string" || result instanceof Uint8Array
                  ? result
                  : JSON.stringify(result);
              state.streamWrite(payload);
            }
            // Auto-close SSE after handler settles unless keepOpen was requested by response.sse
            if (!state.sseKeepOpen) state.streamClose?.();
            return;
          }
          if (result !== undefined && state.streamWrite) {
            if (typeof result === "string" || result instanceof Uint8Array) {
              state.streamWrite(result);
            } else {
              state.streamWrite(JSON.stringify(result));
            }
          }
          // Auto-close for non-SSE streams when handler settles
          state.streamClose?.();
        })
        .catch((err) => {
          const shaped = shapeError(err);
          if (state.streamWrite) {
            state.streamWrite(
              typeof shaped.body === "string"
                ? shaped.body
                : JSON.stringify(shaped.body),
            );
          }
          state.streamClose?.();
        });
      state.onSend = undefined;
      return { result: undefined };
    }

    if (!isStreaming()) {
      type Outcome =
        | { type: "handler"; result: unknown }
        | { type: "error"; error: unknown }
        | { type: "send" };

      const handlerOutcome: Promise<Outcome> = isThenable
        ? (maybePromise as Promise<unknown>).then<Outcome, Outcome>(
          (result) => ({ type: "handler", result }),
          (error) => ({ type: "error", error }),
        )
        : Promise.resolve({ type: "handler", result: maybePromise });

      const raceCandidates: Promise<Outcome>[] = [handlerOutcome];
      if (!state.responded) {
        raceCandidates.push(sendSignal.then<Outcome>(() => ({ type: "send" })));
      }

      const firstSettled = await Promise.race(raceCandidates);

      if (firstSettled.type === "send") {
        handlerOutcome.then((outcome) => {
          if (outcome.type === "error") {
            console.error(
              "[oxian] Handler rejected after response.send completed",
              outcome.error,
            );
          }
        });
        state.onSend = undefined;
        return { result: undefined };
      }

      state.onSend = undefined;
      if (firstSettled.type === "error") {
        throw firstSettled.error;
      }
      const { result } = firstSettled;
      toHttpResponse(result, state);
      return { result };
    }

    const result = await maybePromise;
    if (isStreaming()) {
      // If handler returned synchronously, auto-close stream when it completes (SSE and non-SSE)
      if (result !== undefined && state.streamWrite) {
        if (typeof result === "string" || result instanceof Uint8Array) {
          state.streamWrite(result);
        } else {
          state.streamWrite(JSON.stringify(result));
        }
      }
      // For regular streams, keep open until handler returns; then close here
      if (!(isSse() && state.sseKeepOpen)) state.streamClose?.();
      state.onSend = undefined;
      return { result: undefined };
    }
    state.onSend = undefined;
    toHttpResponse(result, state);
    return { result };
  } catch (err) {
    const shaped = shapeError(err);
    if (isStreaming()) {
      if (state.streamWrite) {
        state.streamWrite(
          typeof shaped.body === "string"
            ? shaped.body
            : JSON.stringify(shaped.body),
        );
      }
      state.streamClose?.();
    } else {
      state.status = shaped.status;
      state.body = shaped.body;
    }
    state.onSend = undefined;
    return { error: err };
  }
}
