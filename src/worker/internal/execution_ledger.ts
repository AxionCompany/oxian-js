export type ExecutionReservation = Readonly<{
  release(): void;
}>;

export type ExecutionLedger = Readonly<{
  reserve(): ExecutionReservation | undefined;
  occupied(): number;
  subscribe(listener: () => void): () => void;
}>;

/**
 * Process-lifetime capacity accounting. A reservation outlives any physical
 * session and is released only by the execution path that owns it.
 */
export function createExecutionLedger(capacity: number): ExecutionLedger {
  const reservations = new Set<symbol>();
  const listeners = new Set<() => void>();

  const publish = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Ledger listeners are internal wake-ups and cannot own execution.
      }
    }
  };

  const reserve = (): ExecutionReservation | undefined => {
    if (reservations.size >= capacity) return undefined;
    const token = Symbol("worker-execution");
    reservations.add(token);
    let released = false;
    return Object.freeze({
      release: (): void => {
        if (released) return;
        released = true;
        if (reservations.delete(token)) publish();
      },
    });
  };

  return Object.freeze({
    reserve,
    occupied: () => reservations.size,
    subscribe: (listener: () => void): () => void => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
