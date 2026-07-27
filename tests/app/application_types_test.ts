import { assertEquals } from "@std/assert";
import { createApplication } from "../../src/app/application.ts";
import type { FileRouter } from "../../src/router/types.ts";

const statefulRouter = Object.freeze({
  root: "file:///routes/",
  routes: Object.freeze([]),
  match: () => null,
}) satisfies FileRouter<{ required: string }>;

function assertApplicationOptionTypes(): void {
  // @ts-expect-error A stateful router cannot manufacture undefined state.
  void createApplication<{ required: string }>({ router: statefulRouter });

  // @ts-expect-error State and setup are mutually exclusive.
  void createApplication({
    router: statefulRouter,
    state: { required: "state" },
    setup: () => ({ required: "setup" }),
  });
}
void assertApplicationOptionTypes;

Deno.test("application state sources preserve stateless and stateful runtime values", async () => {
  const statelessRouter = Object.freeze({
    root: "file:///routes/",
    routes: Object.freeze([]),
    match: () => null,
  }) satisfies FileRouter<undefined>;
  const stateless = await createApplication({ router: statelessRouter });
  assertEquals(stateless.state, undefined);
  await stateless.dispose();

  const stateful = await createApplication({
    router: statefulRouter,
    state: { required: "present" },
  });
  assertEquals(stateful.state, { required: "present" });
  await stateful.dispose();
});
