export type SendAdmission = Readonly<{
  /**
   * Runs `send` once the queue has room for one more frame of `size` bytes.
   * `send` calls `release` when that frame is written or has failed, which
   * makes room for the next. An aborted `signal` drops a frame still waiting,
   * with its reason, and calls `onDrop`; a frame already admitted is unaffected.
   */
  admit<T>(
    size: number,
    signal: AbortSignal | undefined,
    send: (release: () => void) => Promise<T>,
    onDrop?: () => void,
  ): Promise<T>;
  /** Fails every waiting frame, and every later one, with `error`. */
  close(error: unknown): void;
}>;

type Waiter = {
  size: number;
  signal?: AbortSignal;
  start(): void;
  fail(error: unknown): void;
  abort(): void;
};

/**
 * Bounds the frames and bytes queued for writing by making senders wait their
 * turn instead of failing. Admission is first come, first served, so a frame
 * never overtakes one sent before it, and wire order stays call order.
 */
export function createSendAdmission(
  limits: Readonly<{ frames: number; bytes: number }>,
): SendAdmission {
  const waiters: Waiter[] = [];
  let frames = 0;
  let bytes = 0;
  let failure: { error: unknown } | undefined;

  const fits = (size: number): boolean =>
    frames < limits.frames && size <= limits.bytes - bytes;

  const wake = (): void => {
    while (waiters.length > 0 && fits(waiters[0]!.size)) {
      const waiter = waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.start();
    }
  };

  const run = <T>(
    size: number,
    send: (release: () => void) => Promise<T>,
  ): Promise<T> => {
    frames++;
    bytes += size;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      frames--;
      bytes -= size;
      wake();
    };
    try {
      return send(release);
    } catch (error) {
      release();
      return Promise.reject(error);
    }
  };

  const fail = (error: unknown, onDrop?: () => void): Promise<never> => {
    onDrop?.();
    return Promise.reject(error);
  };

  const admit = <T>(
    size: number,
    signal: AbortSignal | undefined,
    send: (release: () => void) => Promise<T>,
    onDrop?: () => void,
  ): Promise<T> => {
    if (failure !== undefined) return fail(failure.error, onDrop);
    if (size > limits.bytes) {
      return fail(
        new RangeError("frame exceeds the send queue byte bound"),
        onDrop,
      );
    }
    if (signal?.aborted) return fail(signal.reason, onDrop);
    if (waiters.length === 0 && fits(size)) return run(size, send);
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        size,
        ...(signal === undefined ? {} : { signal }),
        start: () => void run(size, send).then(resolve, reject),
        fail: (error) => {
          onDrop?.();
          reject(error);
        },
        abort: () => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          onDrop?.();
          reject(signal!.reason);
          // The frame behind it may fit where this one did not.
          wake();
        },
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      waiters.push(waiter);
    });
  };

  const close = (error: unknown): void => {
    if (failure !== undefined) return;
    failure = { error };
    for (const waiter of waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.fail(error);
    }
  };

  return Object.freeze({ admit, close });
}
