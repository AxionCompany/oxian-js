import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../support/assert.ts";
import { createCreditWindow } from "../../src/protocol/index.ts";

test("credit window: grants and consumes bounded byte credit", () => {
  const window = createCreditWindow({
    initialCredit: 4,
    maxCredit: 10,
  });

  assert.deepStrictEqual(window.available(), 4);
  assert.deepStrictEqual(window.canConsume(5), false);
  assert.deepStrictEqual(window.grant(6), 10);
  assert.deepStrictEqual(window.consume(7), 3);
  assert.deepStrictEqual(window.tryConsume(3), true);
  assert.deepStrictEqual(window.available(), 0);
  assert.deepStrictEqual(window.snapshot(), {
    available: 0,
    granted: 10,
    consumed: 10,
    maxCredit: 10,
  });
});

test("credit window: failed consumption does not mutate credit", () => {
  const window = createCreditWindow({ initialCredit: 3 });

  assert.ok(!window.tryConsume(4));
  assert.deepStrictEqual(window.available(), 3);
  assertThrows(
    () => window.consume(4),
    RangeError,
    "insufficient stream credit",
  );
  assert.deepStrictEqual(window.available(), 3);
});

test("credit window: validates amounts and protects the upper bound", () => {
  assertThrows(
    () => createCreditWindow({ initialCredit: -1 }),
    TypeError,
    "initialCredit",
  );
  assertThrows(
    () => createCreditWindow({ initialCredit: 2, maxCredit: 1 }),
    RangeError,
    "must not exceed",
  );

  const window = createCreditWindow({ maxCredit: 5 });
  assertThrows(() => window.grant(0), TypeError, "at least 1");
  window.grant(5);
  assertThrows(() => window.grant(1), RangeError, "would exceed");
});
