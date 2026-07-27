export type CreditWindowOptions = Readonly<{
  initialCredit?: number;
  maxCredit?: number;
}>;

export type CreditWindowSnapshot = Readonly<{
  available: number;
  granted: number;
  consumed: number;
  maxCredit: number;
}>;

export type CreditWindow = Readonly<{
  available(): number;
  canConsume(bytes: number): boolean;
  consume(bytes: number): number;
  grant(bytes: number): number;
  snapshot(): CreditWindowSnapshot;
  tryConsume(bytes: number): boolean;
}>;

function expectCreditAmount(
  value: unknown,
  name: string,
  options: { allowZero: boolean },
): number {
  const minimum = options.allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new TypeError(
      `${name} must be a safe integer of at least ${minimum}`,
    );
  }
  return value;
}

/**
 * Creates a bounded byte-credit window.
 *
 * A receiver grants credit and the sender consumes it before emitting binary
 * payloads. The factory deliberately has no wait queue: transports decide how
 * to suspend producers while this primitive remains deterministic and easy to
 * test.
 */
export function createCreditWindow(
  options: CreditWindowOptions = {},
): CreditWindow {
  const maxCredit = expectCreditAmount(
    options.maxCredit ?? Number.MAX_SAFE_INTEGER,
    "maxCredit",
    { allowZero: false },
  );
  let available = expectCreditAmount(
    options.initialCredit ?? 0,
    "initialCredit",
    { allowZero: true },
  );
  if (available > maxCredit) {
    throw new RangeError("initialCredit must not exceed maxCredit");
  }

  let granted = available;
  let consumed = 0;

  const canConsume = (bytes: number): boolean => {
    expectCreditAmount(bytes, "bytes", { allowZero: true });
    return bytes <= available;
  };

  const tryConsume = (bytes: number): boolean => {
    if (!canConsume(bytes)) return false;
    available -= bytes;
    consumed += bytes;
    return true;
  };

  const consume = (bytes: number): number => {
    if (!tryConsume(bytes)) {
      throw new RangeError(
        `insufficient stream credit: ${bytes} requested, ${available} available`,
      );
    }
    return available;
  };

  const grant = (bytes: number): number => {
    expectCreditAmount(bytes, "bytes", { allowZero: false });
    if (bytes > maxCredit - available) {
      throw new RangeError(
        `stream credit would exceed the ${maxCredit} byte window`,
      );
    }
    available += bytes;
    granted += bytes;
    return available;
  };

  const snapshot = (): CreditWindowSnapshot => ({
    available,
    granted,
    consumed,
    maxCredit,
  });

  return Object.freeze({
    available: () => available,
    canConsume,
    consume,
    grant,
    snapshot,
    tryConsume,
  });
}
