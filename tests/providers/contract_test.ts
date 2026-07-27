import { assert, assertEquals, assertThrows } from "@std/assert";
import type { JsonObject, JsonValue } from "../../src/protocol/types.ts";
import {
  createProviderInspection,
  createProviderResource,
  createProviderTermination,
} from "../../src/providers/index.ts";

function createResource(attributes?: JsonObject) {
  return createProviderResource({
    providerId: "provider",
    resourceId: "resource",
    identity: {
      workerId: "worker",
      attemptId: "attempt",
      epoch: 1,
    },
    createdAtMs: 1,
    attributes,
  });
}

Deno.test("provider JSON is validated, deeply cloned, frozen, and __proto__ safe", () => {
  const source = JSON.parse(
    '{"__proto__":{"polluted":true},"nested":{"items":[1,{"value":"original"}]}}',
  ) as JsonObject;
  const resource = createResource(source);

  const sourceNested = source.nested as {
    items: Array<{ value?: string } | number>;
  };
  (sourceNested.items[1] as { value: string }).value = "mutated";

  assert(Object.isFrozen(resource.attributes));
  assert(Object.isFrozen(resource.attributes.__proto__));
  assert(Object.isFrozen(resource.attributes.nested));
  const nested = resource.attributes.nested as JsonObject;
  assert(Object.isFrozen(nested.items));
  assert(Object.isFrozen((nested.items as readonly JsonValue[])[1]));
  assertEquals(
    ((nested.items as readonly JsonValue[])[1] as JsonObject).value,
    "original",
  );
  assert(Object.hasOwn(resource.attributes, "__proto__"));
  assertEquals(Object.getPrototypeOf(resource.attributes), Object.prototype);
  assertEquals(
    ({} as Record<string, unknown>).polluted,
    undefined,
  );

  const details = JSON.parse(
    '{"__proto__":{"inspection":true},"nested":{"ok":true}}',
  ) as JsonObject;
  const inspection = createProviderInspection({
    resource,
    state: "present",
    observedAtMs: 2,
    details,
  });
  const termination = createProviderTermination({
    resource,
    outcome: "terminated",
    observedAtMs: 3,
    details,
  });
  (details.nested as Record<string, JsonValue>).ok = false;

  assert(Object.isFrozen(inspection.details));
  assert(Object.isFrozen(inspection.details.nested));
  assert(Object.hasOwn(inspection.details, "__proto__"));
  assertEquals(
    (inspection.details.nested as JsonObject).ok,
    true,
  );
  assert(Object.isFrozen(termination.details));
  assert(Object.isFrozen(termination.details.nested));
  assertEquals(
    (termination.details.nested as JsonObject).ok,
    true,
  );
});

Deno.test("provider JSON rejects non-JSON and unsafe object shapes", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  for (
    const attributes of [
      { invalid: undefined },
      { invalid: Number.NaN },
      { invalid: Number.POSITIVE_INFINITY },
      { invalid: 1n },
      circular,
      new Date(),
    ]
  ) {
    assertThrows(
      () => createResource(attributes as unknown as JsonObject),
      TypeError,
      "Invalid provider JSON",
    );
  }

  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => "not data",
  });
  assertThrows(
    () => createResource(accessor as JsonObject),
    TypeError,
    "enumerable data property",
  );

  const resource = createResource();
  assertThrows(
    () =>
      createProviderInspection({
        resource,
        state: "present",
        observedAtMs: 2,
        details: { invalid: undefined } as unknown as JsonObject,
      }),
    TypeError,
    "Invalid provider JSON",
  );
  assertThrows(
    () =>
      createProviderTermination({
        resource,
        outcome: "terminated",
        observedAtMs: 2,
        details: circular as unknown as JsonObject,
      }),
    TypeError,
    "Invalid provider JSON",
  );
});

Deno.test("inspection states and termination outcomes are runtime validated", () => {
  const resource = createResource();
  assertThrows(
    () =>
      createProviderInspection({
        resource,
        state: "ready" as never,
        observedAtMs: 2,
      }),
    TypeError,
    "Invalid provider resource state",
  );
  assertThrows(
    () =>
      createProviderTermination({
        resource,
        outcome: "stopped" as never,
        observedAtMs: 2,
      }),
    TypeError,
    "Invalid provider termination outcome",
  );
});

Deno.test("inspection and termination factories revalidate embedded resources", () => {
  const canonical = createResource();
  const mutableAttributes = {
    nested: {
      value: "original",
    },
  };
  const forged = {
    ...canonical,
    attributes: mutableAttributes,
  };
  const inspection = createProviderInspection({
    resource: forged,
    state: "present",
    observedAtMs: 2,
  });
  const termination = createProviderTermination({
    resource: forged,
    outcome: "terminated",
    observedAtMs: 3,
  });
  mutableAttributes.nested.value = "mutated";

  assert(Object.isFrozen(inspection.resource.attributes));
  assert(Object.isFrozen(inspection.resource.attributes.nested));
  assertEquals(
    (inspection.resource.attributes.nested as JsonObject).value,
    "original",
  );
  assert(Object.isFrozen(termination.resource.attributes));
  assertEquals(
    (termination.resource.attributes.nested as JsonObject).value,
    "original",
  );
});
