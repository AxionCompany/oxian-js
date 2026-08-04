import { assertThrows } from "@std/assert";
import { validatePublishRelease } from "../../scripts/validate_publish_release.ts";

Deno.test("publish contract permits only the exact package version tag", () => {
  validatePublishRelease({
    version: "0.20.0",
    refName: "v0.20.0",
    ref: "refs/tags/v0.20.0",
  });
  validatePublishRelease({
    version: "0.20.0-rc.6",
    refName: "v0.20.0-rc.6",
    ref: "refs/tags/v0.20.0-rc.6",
  });

  assertThrows(
    () =>
      validatePublishRelease({
        version: "0.20.0",
        refName: "v0.20.0",
        ref: "refs/heads/main",
      }),
    Error,
    "Refusing to publish",
  );
  assertThrows(
    () =>
      validatePublishRelease({
        version: "0.20.0",
        refName: "v0.20.1",
        ref: "refs/tags/v0.20.1",
      }),
    Error,
    "Refusing to publish",
  );
});
