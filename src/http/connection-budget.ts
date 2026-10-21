/** Maximum accepted WebSocket connections in a listener's budget. */
export const CONNECTION_BUDGET = 1_000;

/** One accepted connection. Releasing it twice is harmless. */
export type ConnectionLease = Readonly<{ release(): void }>;

/** May be shared by several listeners in the same process. */
export type ConnectionBudget = Readonly<{
  connect(): ConnectionLease;
  snapshot(): Readonly<{ connections: number; budget: number }>;
  /** Refuses new connections; existing leases can still be released. */
  close(): void;
}>;

export function createConnectionBudget(
  maxConnections = CONNECTION_BUDGET,
): ConnectionBudget {
  if (
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 1 ||
    maxConnections > CONNECTION_BUDGET
  ) {
    throw new RangeError(
      `maxConnections must be from 1 to ${CONNECTION_BUDGET}`,
    );
  }
  let connections = 0;
  let closed = false;
  return Object.freeze({
    connect() {
      if (closed) throw new Error("connection budget is closed");
      if (connections >= maxConnections) {
        throw new Error("connection budget exceeded");
      }
      connections += 1;
      let released = false;
      return Object.freeze({
        release() {
          if (released) return;
          released = true;
          connections -= 1;
        },
      });
    },
    snapshot: () => Object.freeze({ connections, budget: maxConnections }),
    close() {
      closed = true;
    },
  });
}
