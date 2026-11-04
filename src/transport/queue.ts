export type BoundedAsyncQueueOptions<T> = Readonly<{
  maxItems: number;
  maxWeight: number;
  weigh(value: T): number;
}>;

export type BoundedAsyncQueueSnapshot = Readonly<{
  items: number;
  weight: number;
  closed: boolean;
}>;

export type BoundedAsyncQueue<T> = Readonly<{
  push(value: T): boolean;
  /**
   * Undefined when an item of `weight` fits now; otherwise resolves once it
   * would, or the queue closed. A single producer awaits it before each push,
   * so a full queue holds it back.
   */
  room(weight: number): Promise<void> | undefined;
  close(error?: unknown, options?: Readonly<{ discard?: boolean }>): void;
  snapshot(): BoundedAsyncQueueSnapshot;
  iterable: AsyncIterable<T>;
}>;

type Waiter<T> = {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
};

function expectPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

export function createBoundedAsyncQueue<T>(
  options: BoundedAsyncQueueOptions<T>,
): BoundedAsyncQueue<T> {
  const maxItems = expectPositiveInteger(options.maxItems, "maxItems");
  const maxWeight = expectPositiveInteger(options.maxWeight, "maxWeight");
  const values: Array<{ value: T; weight: number }> = [];
  const waiters: Waiter<T>[] = [];
  let weight = 0;
  let closed = false;
  let closeError: unknown;
  let roomWaiter: { weight: number; resolve(): void } | undefined;

  const fits = (itemWeight: number): boolean =>
    values.length < maxItems && itemWeight <= maxWeight - weight;

  const wakeProducer = (): void => {
    if (roomWaiter === undefined || (!closed && !fits(roomWaiter.weight))) {
      return;
    }
    const waiter = roomWaiter;
    roomWaiter = undefined;
    waiter.resolve();
  };

  const room = (itemWeight: number): Promise<void> | undefined => {
    // One larger than the whole bound can never fit; its push will refuse it.
    if (closed || fits(itemWeight) || itemWeight > maxWeight) {
      return undefined;
    }
    return new Promise<void>((resolve) => {
      roomWaiter = { weight: itemWeight, resolve };
    });
  };

  const push = (value: T): boolean => {
    if (closed) return false;
    const valueWeight = options.weigh(value);
    if (!Number.isSafeInteger(valueWeight) || valueWeight < 0) {
      throw new TypeError("queue item weight must be a non-negative integer");
    }

    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return true;
    }
    if (values.length >= maxItems || valueWeight > maxWeight - weight) {
      return false;
    }
    values.push({ value, weight: valueWeight });
    weight += valueWeight;
    return true;
  };

  const close = (
    error?: unknown,
    closeOptions: Readonly<{ discard?: boolean }> = {},
  ): void => {
    if (closed) return;
    closed = true;
    closeError = error;
    if (closeOptions.discard === true) {
      values.length = 0;
      weight = 0;
    }
    wakeProducer();
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (waiter === undefined) break;
      if (error === undefined) {
        waiter.resolve({ done: true, value: undefined });
      } else {
        waiter.reject(error);
      }
    }
  };

  const next = (): Promise<IteratorResult<T>> => {
    const entry = values.shift();
    if (entry !== undefined) {
      weight -= entry.weight;
      wakeProducer();
      return Promise.resolve({ done: false, value: entry.value });
    }
    if (closed) {
      return closeError === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(closeError);
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  };

  const iterable: AsyncIterable<T> = Object.freeze({
    [Symbol.asyncIterator]: () => ({ next }),
  });

  return Object.freeze({
    push,
    room,
    close,
    snapshot: () => ({
      items: values.length,
      weight,
      closed,
    }),
    iterable,
  });
}
