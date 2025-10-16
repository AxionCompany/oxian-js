import type { ResponseController } from "../core/types.ts";

export type ResponseState = {
  status: number;
  headers: Headers;
  statusText?: string;
  body?: unknown;
  streamWrite?: (chunk: Uint8Array | string) => void;
  streamClose?: () => void;
  // internal flag to control SSE lifecycle
  sseKeepOpen?: boolean;
};

export function createResponseController(): {
  controller: ResponseController;
  state: ResponseState;
} {
  const state: ResponseState = { status: 200, headers: new Headers() };

  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  const encoder = new TextEncoder();

  const controller: ResponseController = {
    send(body: unknown, init) {
      if (init?.status !== undefined) state.status = init.status;
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers)) {
          state.headers.set(k, v);
        }
      }
      if (init?.statusText) state.statusText = init.statusText;
      state.body = body;
    },
    redirect(url: string, status: 301 | 302 | 303 | 307 | 308 = 302) {
      state.status = status;
      state.headers.set("location", url);
      // Do not set a body here; let finalizeResponse return an empty body with proper status
    },
    stream(initOrChunk) {
      // If first arg is a chunk, ensure stream is open and write without closing.
      if (
        typeof initOrChunk === "string" || initOrChunk instanceof Uint8Array
      ) {
        // If stream is not open yet, open it with defaults
        if (!(state.body instanceof ReadableStream)) {
          const w = controller.stream({});
          // w is the writer; will be used below to write the chunk
          (w as ((chunk: Uint8Array | string) => void))(initOrChunk);
        } else if (state.streamWrite) {
          state.streamWrite(initOrChunk);
        }
        return;
      }

      const init = initOrChunk;
      if (init?.status !== undefined) state.status = init.status;
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers)) {
          state.headers.set(k, v);
        }
      }
      if (init?.statusText) state.statusText = init.statusText;

      // Hint intermediaries not to buffer streamed responses
      state.headers.set(
        "cache-control",
        state.headers.get("cache-control") ?? "no-cache, no-transform",
      );
      state.headers.set(
        "x-accel-buffering",
        state.headers.get("x-accel-buffering") ?? "no",
      );

      let resolveDone: () => void;
      const done = new Promise<void>((res) => {
        resolveDone = res;
      });

      const rs = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
        cancel() {
          streamController = null;
          resolveDone?.();
        },
      });
      state.body = rs;

      const writeFnBase = (chunk: Uint8Array | string) => {
        if (!streamController) return;
        if (typeof chunk === "string") {
          if (chunk === "") {
            try {
              streamController.close();
            } catch (_e) { /* ignore close error */ }
            streamController = null;
            resolveDone?.();
            return;
          }
          streamController.enqueue(encoder.encode(chunk));
          return;
        }
        if (chunk.byteLength === 0) {
          try {
            streamController.close();
          } catch (_e) { /* ignore close error */ }
          streamController = null;
          resolveDone?.();
          return;
        }
        streamController.enqueue(chunk);
      };

      type WriteFn = ((chunk: Uint8Array | string) => void) & {
        close?: () => void;
        done?: Promise<void>;
      };
      const writeFn: WriteFn = writeFnBase as WriteFn;

      state.streamWrite = writeFnBase;
      state.streamClose = () => {
        if (!streamController) return;
        try {
          streamController.close();
        } catch (_e) { /* ignore close error */ }
        streamController = null;
        resolveDone?.();
      };

      // Expose explicit close() and done for convenience
      writeFn.close = state.streamClose;
      writeFn.done = done;

      return writeFn;
    },
    sse(init) {
      state.status = init?.status ?? 200;
      state.sseKeepOpen = init?.keepOpen === true;
      // set SSE headers
      state.headers.set("content-type", "text/event-stream; charset=utf-8");
      state.headers.set("cache-control", "no-cache");
      state.headers.set("connection", "keep-alive");
      state.headers.set("x-accel-buffering", "no");
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers)) {
          state.headers.set(k, v);
        }
      }

      let resolveDone: () => void;
      const done = new Promise<void>((res) => {
        resolveDone = res;
      });

      const rs = new ReadableStream<Uint8Array>({
        start(c) {
          streamController = c;
        },
        cancel() {
          streamController = null;
          resolveDone?.();
        },
      });
      state.body = rs;

      const writeLine = (line: string) => {
        if (!streamController) return;
        streamController.enqueue(encoder.encode(line + "\n"));
      };

      if (init?.retry !== undefined) writeLine(`retry: ${init.retry}`);

      const api = {
        send: (
          data: unknown,
          opts?: { event?: string; id?: string; retry?: number },
        ) => {
          if (!streamController) return;
          if (opts?.id) writeLine(`id: ${opts.id}`);
          if (opts?.event) writeLine(`event: ${opts.event}`);
          if (opts?.retry !== undefined) writeLine(`retry: ${opts.retry}`);
          const payload = typeof data === "string"
            ? data
            : JSON.stringify(data);
          for (const line of payload.split("\n")) writeLine(`data: ${line}`);
          writeLine(""); // dispatch
        },
        comment: (text: string) => writeLine(`:${text}`),
        close: () => {
          if (!streamController) return;
          try {
            streamController.close();
          } catch (_e) { /* ignore close error */ }
          streamController = null;
          resolveDone?.();
        },
        get done() {
          return done;
        },
      };

      // Also expose close via state for pipeline
      state.streamWrite = (chunk) =>
        api.send(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
        );
      state.streamClose = api.close;

      return api;
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
    return new Response(null, {
      status: state.status,
      statusText: state.statusText,
      headers: state.headers,
    });
  }
  if (body instanceof ReadableStream) {
    if (!state.headers.has("content-type")) {
      state.headers.set("content-type", "text/plain; charset=utf-8");
    }
    return new Response(body, {
      status: state.status,
      statusText: state.statusText,
      headers: state.headers,
    });
  }
  if (typeof body === "string" || body instanceof Uint8Array) {
    if (!state.headers.has("content-type")) {
      state.headers.set(
        "content-type",
        typeof body === "string"
          ? "text/plain; charset=utf-8"
          : "application/octet-stream",
      );
    }
    return new Response(body, {
      status: state.status,
      statusText: state.statusText,
      headers: state.headers,
    });
  }
  if (!state.headers.has("content-type")) {
    state.headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), {
    status: state.status,
    statusText: state.statusText,
    headers: state.headers,
  });
}
