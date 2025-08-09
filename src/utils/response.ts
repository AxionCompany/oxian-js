import { ResponseController } from "../core/types.ts";

export type ResponseState = {
  status: number;
  headers: Headers;
  statusText?: string;
  body?: unknown;
  streamWrite?: (chunk: Uint8Array | string) => void;
  streamClose?: () => void;
};

export function createResponseController(): { controller: ResponseController; state: ResponseState } {
  const state: ResponseState = { status: 200, headers: new Headers() };

  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  const controller: ResponseController = {
    send(body: unknown, init) {
      if (init?.status !== undefined) state.status = init.status;
      if (init?.headers) for (const [k, v] of Object.entries(init.headers)) state.headers.set(k, v);
      if (init?.statusText) state.statusText = init.statusText;
      state.body = body;
    },
    stream(init) {
      if (init?.status !== undefined) state.status = init.status;
      if (init?.headers) for (const [k, v] of Object.entries(init.headers)) state.headers.set(k, v);
      if (init?.statusText) state.statusText = init.statusText;

      const rs = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
        cancel() {
          streamController = null;
        },
      });
      state.body = rs;

      const encoder = new TextEncoder();
      const writeFn = (chunk: Uint8Array | string) => {
        if (!streamController) return;
        if (typeof chunk === "string") {
          if (chunk === "") {
            try { streamController.close(); } catch {}
            streamController = null;
            return;
          }
          streamController.enqueue(encoder.encode(chunk));
          return;
        }
        if (chunk.byteLength === 0) {
          try { streamController.close(); } catch {}
          streamController = null;
          return;
        }
        streamController.enqueue(chunk);
      };

      state.streamWrite = writeFn;
      state.streamClose = () => {
        if (!streamController) return;
        try { streamController.close(); } catch {}
        streamController = null;
      };

      return writeFn;
    },
    status(code: number) {
      state.status = code;
    },
    headers(h: Record<string, string>) {
      for (const [k, v] of Object.entries(h)) state.headers.set(k, v);
    },
    statusText(text: string) {
      state.statusText = text;
    },
  };

  return { controller, state };
}

export function finalizeResponse(state: ResponseState): Response {
  const body = state.body;
  if (body === undefined || body === null) {
    return new Response(null, { status: state.status, statusText: state.statusText, headers: state.headers });
  }
  if (body instanceof ReadableStream) {
    if (!state.headers.has("content-type")) state.headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(body, { status: state.status, statusText: state.statusText, headers: state.headers });
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    if (!state.headers.has("content-type")) {
      state.headers.set("content-type", typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
    }
    return new Response(body, { status: state.status, statusText: state.statusText, headers: state.headers });
  }
  if (!state.headers.has("content-type")) state.headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status: state.status, statusText: state.statusText, headers: state.headers });
} 