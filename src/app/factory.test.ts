import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../../tests/support/assert.ts";
import { join } from "node:path";
import { pathToFileURL as toFileUrl } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApplication } from "./application.ts";
import { defineApplicationFactory, loadApplicationFactory } from "./factory.ts";
import type { FileRouter } from "../router/types.ts";

function createRouter(root: string): FileRouter<unknown> {
  return Object.freeze({
    root,
    routes: Object.freeze([]),
    match: () => null,
  });
}

async function withModule(
  source: string,
  run: (path: string) => void | Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oxian_app_factory_"));
  const path = join(directory, "application.ts");
  await writeFile(path, source);
  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true });
  }
}

test("defineApplicationFactory rejects structural and mount mismatches", async () => {
  const router = createRouter("file:///routes/");
  const otherRouter = createRouter("file:///other/");
  const signal = new AbortController().signal;

  const missing = defineApplicationFactory(
    () =>
      Object.freeze({
        router,
        basePath: "/",
      }) as never,
  );
  await assertRejects(
    async () => await missing({ router, basePath: "/", signal }),
    TypeError,
    'application factory result is missing "state"',
  );

  let mismatchedApplication:
    | Awaited<ReturnType<typeof createApplication>>
    | undefined;
  const wrongRouter = defineApplicationFactory(async () => {
    mismatchedApplication = await createApplication({
      router: otherRouter,
      basePath: "/api",
    });
    return mismatchedApplication;
  });
  await assertRejects(
    async () => await wrongRouter({ router, basePath: "/api", signal }),
    TypeError,
    "using the provided router",
  );
  await mismatchedApplication?.dispose();

  let wrongMountApplication:
    | Awaited<ReturnType<typeof createApplication>>
    | undefined;
  let wrongMountDisposeCalls = 0;
  const wrongMount = defineApplicationFactory(async () => {
    wrongMountApplication = await createApplication({
      router,
      basePath: "/other",
      dispose: () => {
        wrongMountDisposeCalls++;
      },
    });
    return wrongMountApplication;
  });
  await assertRejects(
    async () => await wrongMount({ router, basePath: "/api", signal }),
    TypeError,
    "using the provided basePath",
  );
  assert.deepStrictEqual(wrongMountDisposeCalls, 1);
  assert.deepStrictEqual(wrongMountApplication?.snapshot(), {
    acceptingRequests: false,
    activeRequests: 0,
  });
  await wrongMountApplication?.dispose();
  assert.deepStrictEqual(wrongMountDisposeCalls, 1);

  assertThrows(
    () => defineApplicationFactory(null as never),
    TypeError,
    "must be a function",
  );
});

test("factory cleanup cannot replace a Proxy validation error", async () => {
  const router = createRouter("file:///routes/");
  const signal = new AbortController().signal;
  const validationError = new Error("factory_result_reflection_failed");
  const cleanupError = new Error("cleanup_reflection_failed");
  const hostileResult = new Proxy(
    {},
    {
      ownKeys() {
        throw validationError;
      },
      getOwnPropertyDescriptor() {
        throw cleanupError;
      },
    },
  );
  const factory = defineApplicationFactory(() => hostileResult as never);

  let rejection: unknown;
  try {
    await factory({ router, basePath: "/", signal });
  } catch (error) {
    rejection = error;
  }
  assert.strictEqual(rejection, validationError);
});

test("loadApplicationFactory requires one local default .ts export", async () => {
  await withModule(
    `export default function applicationFactory() { return {}; }\n`,
    async (path) => {
      const factory = await loadApplicationFactory(path);
      assert.deepStrictEqual(typeof factory, "function");
      assert.deepStrictEqual(Object.isFrozen(factory), true);
    },
  );
  await withModule(
    `export const helper = 1; export default function factory() {}\n`,
    async (path) => {
      await assertRejects(
        () => loadApplicationFactory(path),
        TypeError,
        'may only export "default"; found extra export "helper"',
      );
    },
  );
  await withModule(`export const factory = () => {};\n`, async (path) => {
    await assertRejects(
      () => loadApplicationFactory(path),
      TypeError,
      "must export exactly one default factory",
    );
  });
  await withModule(`export default 42;\n`, async (path) => {
    await assertRejects(
      () => loadApplicationFactory(path),
      TypeError,
      "must be a function",
    );
  });
  await assertRejects(
    () => loadApplicationFactory("https://example.test/application.ts"),
    TypeError,
    "local .ts module",
  );
  await assertRejects(
    () => loadApplicationFactory(toFileUrl("/tmp/application.js")),
    TypeError,
    "local .ts module",
  );
});
