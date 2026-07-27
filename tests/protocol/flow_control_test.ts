import { assertEquals, assertFalse, assertThrows } from "@std/assert";
import { createCreditWindow } from "../../src/protocol/index.ts";

Deno.test("credit window: grants and consumes bounded byte credit", () => {
  const window = createCreditWindow({
    initialCredit: 4,
    maxCredit: 10,
  });

  assertEquals(window.available(), 4);
  assertEquals(window.canConsume(5), false);
  assertEquals(window.grant(6), 10);
  assertEquals(window.consume(7), 3);
  assertEquals(window.tryConsume(3), true);
  assertEquals(window.available(), 0);
  assertEquals(window.snapshot(), {
    available: 0,
    granted: 10,
    consumed: 10,
    maxCredit: 10,
  });
});

Deno.test("credit window: failed consumption does not mutate credit", () => {
  const window = createCreditWindow({ initialCredit: 3 });

  assertFalse(window.tryConsume(4));
  assertEquals(window.available(), 3);
  assertThrows(
    () => window.consume(4),
    RangeError,
    "insufficient stream credit",
  );
  assertEquals(window.available(), 3);
});

Deno.test("credit window: validates amounts and protects the upper bound", () => {
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
