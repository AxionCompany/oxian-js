import assert from "node:assert/strict";

type ErrorClass<E extends Error> = abstract new (...args: never[]) => E;

/** Like `assert.throws`, but returns the thrown error. */
export function assertThrows(fn: () => unknown, message?: string): unknown;
export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  errorClass: ErrorClass<E>,
  messageIncludes?: string,
  message?: string,
): E;
export function assertThrows<E extends Error>(
  fn: () => unknown,
  errorClassOrMessage?: ErrorClass<E> | string,
  messageIncludes?: string,
  message?: string,
): unknown {
  try {
    fn();
  } catch (error) {
    return check(error, errorClassOrMessage, messageIncludes, message);
  }
  assert.fail(message ?? "Expected function to throw.");
}

/** Like `assert.rejects`, but resolves to the rejection reason. */
export function assertRejects(
  fn: () => PromiseLike<unknown>,
  message?: string,
): Promise<unknown>;
export function assertRejects<E extends Error = Error>(
  fn: () => PromiseLike<unknown>,
  errorClass: ErrorClass<E>,
  messageIncludes?: string,
  message?: string,
): Promise<E>;
export async function assertRejects<E extends Error>(
  fn: () => PromiseLike<unknown>,
  errorClassOrMessage?: ErrorClass<E> | string,
  messageIncludes?: string,
  message?: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return check(error, errorClassOrMessage, messageIncludes, message);
  }
  assert.fail(message ?? "Expected function to reject.");
}

function check<E extends Error>(
  error: unknown,
  errorClassOrMessage: ErrorClass<E> | string | undefined,
  messageIncludes: string | undefined,
  message: string | undefined,
): unknown {
  if (typeof errorClassOrMessage !== "function") return error;
  assert.ok(
    error instanceof errorClassOrMessage,
    message ??
      `Expected error to be instance of "${errorClassOrMessage.name}", but was "${
        (error as Error | undefined)?.constructor?.name
      }".`,
  );
  if (messageIncludes !== undefined) {
    assert.ok(
      error.message.includes(messageIncludes),
      message ??
        `Expected error message to include "${messageIncludes}", but got "${error.message}".`,
    );
  }
  return error;
}
