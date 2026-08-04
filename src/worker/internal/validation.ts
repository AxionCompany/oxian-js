export function expectPositiveInteger(
  value: unknown,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > maximum
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
  return resolved;
}

export function expectNonNegativeInteger(
  value: unknown,
  name: string,
  fallback: number,
): number {
  const resolved = value ?? fallback;
  if (
    typeof resolved !== "number" ||
    !Number.isSafeInteger(resolved) ||
    resolved < 0
  ) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved;
}
