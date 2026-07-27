import type {
  ServerSentEventOptions,
  ServerSentEvents,
  ServerSentEventsOptions,
} from "./types.ts";

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_BUFFER_BYTES = 64 * 1024;

function expectPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function expectSingleLine(value: string, name: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new TypeError(`${name} must not contain a newline`);
  }
  return value;
}

function expectRetry(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function expectStatus(value: number): number {
  if (
    !Number.isSafeInteger(value) || value < 200 || value > 599 ||
    value === 204 || value === 205 || value === 304
  ) {
    throw new TypeError(
      "SSE status must be a body-compatible HTTP status from 200 through 599",
    );
  }
  return value;
}

function formatData(data: unknown): string {
  if (typeof data === "string") return data;
  const encoded = JSON.stringify(data);
  return encoded === undefined ? "null" : encoded;
}

function formatEvent(
  data: unknown,
  options: ServerSentEventOptions,
): string {
  const lines: string[] = [];
  if (options.id !== undefined) {
    lines.push(`id: ${expectSingleLine(options.id, "event id")}`);
  }
  if (options.event !== undefined) {
    lines.push(`event: ${expectSingleLine(options.event, "event name")}`);
  }
  if (options.retry !== undefined) {
    lines.push(`retry: ${expectRetry(options.retry, "event retry")}`);
  }
  for (const line of formatData(data).split(/\r\n|\r|\n/)) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * Creates a native streaming SSE response. Writes are serialized and awaited,
 * while a small readable-side buffer permits the first event to become
 * observable before a consumer starts pulling.
 */
export function createServerSentEvents(
  options: ServerSentEventsOptions = {},
): ServerSentEvents {
  const maxEventBytes = expectPositiveInteger(
    options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
    "maxEventBytes",
  );
  const bufferBytes = expectPositiveInteger(
    options.bufferBytes ?? DEFAULT_BUFFER_BYTES,
    "bufferBytes",
  );
  const status = expectStatus(options.status ?? 200);
  const retry = options.retry === undefined
    ? undefined
    : expectRetry(options.retry, "retry");
  const headers = new Headers(options.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes }),
    new ByteLengthQueuingStrategy({ highWaterMark: bufferBytes }),
  );
  const writer = stream.writable.getWriter();

  let state: "open" | "closing" | "aborting" | "closed" = "open";
  let tail = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let abortPromise: Promise<void> | undefined;

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    if (state !== "open") {
      return Promise.reject(new TypeError("SSE stream is closed"));
    }
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  };

  const writeText = (createText: () => string): Promise<void> =>
    enqueue(() => {
      const bytes = encoder.encode(createText());
      if (bytes.byteLength > maxEventBytes) {
        return Promise.reject(
          new TypeError(
            `SSE event exceeds maxEventBytes (${bytes.byteLength} > ${maxEventBytes})`,
          ),
        );
      }
      return writer.write(bytes);
    });

  const send = (
    data: unknown,
    eventOptions: ServerSentEventOptions = {},
  ): Promise<void> => writeText(() => formatEvent(data, eventOptions));

  const comment = (text: string): Promise<void> =>
    writeText(() => {
      const formatted = text.split(/\r\n|\r|\n/)
        .map((line) => `:${line}`)
        .join("\n");
      return `${formatted}\n\n`;
    });

  const close = (): Promise<void> => {
    if (abortPromise !== undefined) return abortPromise;
    if (closePromise !== undefined) return closePromise;
    if (state === "closed") return Promise.resolve();

    state = "closing";
    closePromise = (async () => {
      await tail;
      if (abortPromise !== undefined) {
        await abortPromise;
        return;
      }
      await writer.close();
      state = "closed";
    })().catch(async (error) => {
      if (abortPromise !== undefined) {
        await abortPromise;
        return;
      }
      state = "closed";
      throw error;
    });
    return closePromise;
  };

  const abort = (reason: unknown = "sse_aborted"): Promise<void> => {
    if (abortPromise !== undefined) return abortPromise;
    if (state === "closed") return Promise.resolve();

    state = "aborting";
    abortPromise = (async () => {
      await writer.abort(reason).catch(() => undefined);
      await tail;
      state = "closed";
    })();
    return abortPromise;
  };

  const signal = options.signal;
  const onAbort = (): void => {
    void abort(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  const closed = writer.closed.catch(() => undefined).finally(() => {
    state = "closed";
    signal?.removeEventListener("abort", onAbort);
  });

  if (retry !== undefined) {
    void writeText(() => `retry: ${retry}\n\n`).catch(() => undefined);
  }

  return Object.freeze({
    response: new Response(stream.readable, {
      status,
      headers,
    }),
    send,
    comment,
    close,
    abort,
    closed,
  });
}
