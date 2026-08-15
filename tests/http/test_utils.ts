import type { JsonObject } from "../../src/protocol/types.ts";
import type { WorkDispatch } from "../../src/supervisor/index.ts";
import type { WorkHandle } from "../../src/work/types.ts";

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}>;

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readChunks(
  stream: ReadableStream<Uint8Array>,
): Promise<readonly Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return concat(await readChunks(stream));
}

export function streamOf(
  ...chunks: readonly Uint8Array[]
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
  }, { highWaterMark: 0 });
}

export function createHandle(
  input: Readonly<{
    metadata: JsonObject | Promise<JsonObject>;
    output?: ReadableStream<Uint8Array>;
    cancel?(reason?: string): void;
  }>,
): WorkHandle {
  const completed = Object.freeze({
    operationId: "operation-http",
    status: "completed",
  }) as WorkDispatch;
  return Object.freeze({
    operationId: "operation-http",
    streamId: "00000000-0000-4000-8000-000000000001",
    metadata: Promise.resolve(input.metadata),
    output: input.output ?? streamOf(),
    started: Promise.resolve(),
    completed: Promise.resolve(completed),
    cancel: (reason?: string) => {
      input.cancel?.(reason);
      return Promise.resolve(completed);
    },
  });
}
