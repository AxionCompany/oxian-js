import { WORKER_PROTOCOL_LIMITS } from "../protocol/limits.ts";

export function rechunkHttpBody(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const limit = WORKER_PROTOCOL_LIMITS.maxDataPayloadBytes;
  let staged: Uint8Array | undefined;
  let offset = 0;
  let terminal = false;
  let released = false;

  const release = (): void => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal) return;
      try {
        while (staged === undefined || offset >= staged.byteLength) {
          staged = undefined;
          offset = 0;
          const next = await reader.read();
          if (terminal) return;
          if (next.done) {
            terminal = true;
            release();
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array)) {
            throw new TypeError("HTTP body streams must yield Uint8Array");
          }
          if (next.value.byteLength === 0) continue;
          staged = next.value;
        }

        const end = Math.min(staged.byteLength, offset + limit);
        controller.enqueue(staged.subarray(offset, end));
        offset = end;
      } catch (error) {
        if (terminal) return;
        terminal = true;
        try {
          await reader.cancel(error);
        } catch {
          // The original read/validation failure remains authoritative.
        }
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (terminal) return;
      terminal = true;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  }, { highWaterMark: 0 });
}
