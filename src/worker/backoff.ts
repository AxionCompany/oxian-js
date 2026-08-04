import type { WorkerReconnectContext, WorkerReconnectDelay } from "./types.ts";

export type BoundedExponentialBackoffOptions = Readonly<{
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
  jitter?: number;
  maxAttempts?: number;
  random?: () => number;
}>;

function expectFiniteNumber(
  value: unknown,
  name: string,
  options: Readonly<{ min: number; max?: number }>,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < options.min ||
    (options.max !== undefined && value > options.max)
  ) {
    throw new TypeError(
      `${name} must be a finite number between ${options.min} and ${
        options.max ?? "Infinity"
      }`,
    );
  }
  return value;
}

/**
 * Creates an exponential reconnect policy whose returned delay is always
 * bounded. Attempts are unlimited unless `maxAttempts` is supplied.
 */
export function createBoundedExponentialBackoff(
  options: BoundedExponentialBackoffOptions = {},
): WorkerReconnectDelay {
  const initialDelayMs = expectFiniteNumber(
    options.initialDelayMs ?? 250,
    "initialDelayMs",
    { min: 0 },
  );
  const maxDelayMs = expectFiniteNumber(
    options.maxDelayMs ?? 30_000,
    "maxDelayMs",
    { min: initialDelayMs },
  );
  const multiplier = expectFiniteNumber(
    options.multiplier ?? 2,
    "multiplier",
    { min: 1 },
  );
  const jitter = expectFiniteNumber(
    options.jitter ?? 0.2,
    "jitter",
    { min: 0, max: 1 },
  );
  const maxAttempts = options.maxAttempts === undefined
    ? undefined
    : expectFiniteNumber(options.maxAttempts, "maxAttempts", { min: 1 });
  if (
    maxAttempts !== undefined &&
    !Number.isSafeInteger(maxAttempts)
  ) {
    throw new TypeError("maxAttempts must be a positive safe integer");
  }
  const random = options.random ?? Math.random;

  return ({ attempt }: WorkerReconnectContext): number | null => {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new TypeError("reconnect attempt must be a positive safe integer");
    }
    if (maxAttempts !== undefined && attempt > maxAttempts) return null;

    const exponential = initialDelayMs * multiplier ** (attempt - 1);
    const base = Math.min(maxDelayMs, exponential);
    const sample = expectFiniteNumber(random(), "random()", {
      min: 0,
      max: 1,
    });
    const factor = 1 - jitter + sample * jitter * 2;
    return Math.max(0, Math.min(maxDelayMs, Math.round(base * factor)));
  };
}
