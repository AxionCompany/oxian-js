import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextVersion,
  prereleaseId,
  stableVersion,
} from "../../scripts/next_version.mjs";

test("a main commit becomes x.y.z-next.<shortsha>", () => {
  assert.equal(stableVersion("0.21.2"), "0.21.2");
  assert.equal(
    nextVersion("0.21.2", "abcdef1234567890abcd"),
    "0.21.2-next.abcdef1",
  );
  assert.equal(prereleaseId("0123456789abcdef"), "0123456789a");
  assert.throws(() => stableVersion("0.21.2-next.abcdef1"), /stable x\.y\.z/);
  assert.throws(() => nextVersion("0.21.2", "abc"), /7 to 40 hex/);
});
