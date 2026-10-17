import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Application } from "../../app/types.ts";

const APP_URL = new URL("../../app/index.ts", import.meta.url).href;
const CONFIG_URL = new URL("../../config/index.ts", import.meta.url).href;

async function withFiles(
  files: Record<string, string>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oxian config #% é-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Node loads typed config and factory paths with URL-reserved characters", async () => {
  const { loadConfig } = await import("../../config/index.ts");
  const { createConfiguredApplication } = await import("../../app/index.ts");
  await withFiles(
    {
      "oxian.config.ts": `
        import { defineConfig, type OxianConfigInput } from ${JSON.stringify(CONFIG_URL)};
        const input: OxianConfigInput = {
          application: { routesRoot: './routes', basePath: '/api', factory: './application.ts' },
          gateway: { edge: { static: { root: '../public' } } }
        };
        export default defineConfig(input);
      `,
      "application.ts": `
        import { createApplication, defineApplicationFactory } from ${JSON.stringify(APP_URL)};
        export default defineApplicationFactory((context) => {
          if (!Object.isFrozen(context)) throw new Error('context_not_frozen');
          const { router, basePath, signal } = context;
          signal.throwIfAborted();
          return createApplication({ router, basePath, state: { prefix: 'native:' } });
        });
      `,
      "routes/[id].ts": `
        export const GET = (_request: Request, context: { state: { prefix: string }, params: { id: string } }) =>
          new Response(context.state.prefix + context.params.id);
      `,
    },
    async (directory) => {
      const path = join(directory, "oxian.config.ts");
      const config = await loadConfig(relative(process.cwd(), path));
      assert.deepEqual(await loadConfig(pathToFileURL(path)), config);
      assert.deepEqual(await loadConfig(pathToFileURL(path).href), config);
      assert.equal(config.application.routesRoot, join(directory, "routes"));
      assert.equal(
        config.application.factory,
        join(directory, "application.ts"),
      );
      assert.equal(
        config.gateway.edge?.static?.root,
        join(directory, "../public"),
      );
      const result = await createConfiguredApplication({
        config: config.application,
        signal: new AbortController().signal,
      });
      try {
        assert.ok(Object.isFrozen(result));
        assert.equal(result.application.router, result.router);
        const response = await result.application.fetch(
          new Request("https://example.test/api/alice%20smith"),
        );
        assert.equal(await response.text(), "native:alice smith");
      } finally {
        await result.application.dispose();
      }
    },
  );
});

test("Node configured application retains the default path and router abort checks", async () => {
  const { defineConfig } = await import("../../config/index.ts");
  const { createConfiguredApplication } = await import("../../app/index.ts");
  await withFiles(
    { "index.ts": 'export const GET = () => new Response("default");' },
    async (directory) => {
      const config = defineConfig({
        application: {
          routesRoot: pathToFileURL(directory).href,
          basePath: "/app",
        },
      }).application;
      const { application, router } = await createConfiguredApplication({
        config,
        signal: new AbortController().signal,
      });
      try {
        assert.equal(
          await (
            await application.fetch(new Request("https://example.test/app"))
          ).text(),
          "default",
        );
        const controller = new AbortController();
        let calls = 0;
        const options = {
          config,
          signal: controller.signal,
          createRouter: async () => {
            await Promise.resolve();
            calls++;
            controller.abort(new Error("router_aborted"));
            return router;
          },
        };
        await assert.rejects(
          createConfiguredApplication(options),
          /router_aborted/,
        );
        assert.equal(calls, 1);
        await assert.rejects(
          createConfiguredApplication(options),
          /router_aborted/,
        );
        assert.equal(calls, 1);
      } finally {
        await application.dispose();
      }
    },
  );
});

test("Node config and factory loaders reject non-TypeScript and non-local sources before import", async () => {
  const { loadConfig } = await import("../../config/index.ts");
  const { loadApplicationFactory } = await import("../../app/index.ts");
  await withFiles(
    {
      "rejected.js": 'throw new Error("must_not_import");',
      "rejected.mts": 'throw new Error("must_not_import");',
      "rejected.json": '{"not":"config"}',
      "rejected.ts": 'throw new Error("must_not_import");',
    },
    async (directory) => {
      const module = pathToFileURL(join(directory, "rejected.ts"));
      for (const load of [loadConfig, loadApplicationFactory]) {
        for (const source of [
          ...["js", "mts", "json"].map((extension) =>
            join(directory, `rejected.${extension}`),
          ),
          `${module.href}?cache=1`,
          `${module.href}#fragment`,
          "https://example.test/rejected.ts",
          "data:text/javascript,export default {}",
        ]) {
          await assert.rejects(load(source), TypeError);
        }
      }
    },
  );
});

test("Node configured application disposes a factory result when cancellation wins", async () => {
  const { createConfiguredApplication } = await import("../../app/index.ts");
  const { defineConfig } = await import("../../config/index.ts");
  await withFiles(
    {
      "control.ts": `
        import { createApplication } from ${JSON.stringify(APP_URL)};
        export const controller = new AbortController();
        export let application;
        export async function build({ router, basePath }) {
          application = await createApplication({ router, basePath });
          controller.abort(new Error('factory_cancelled'));
          return application;
        }
      `,
      "application.ts":
        'import { build } from "./control.ts"; export default build;',
      "routes/index.ts": 'export const GET = () => new Response("unused");',
    },
    async (directory) => {
      const control = (await import(
        pathToFileURL(join(directory, "control.ts")).href
      )) as {
        controller: AbortController;
        application: Application<unknown>;
      };
      const config = defineConfig({
        application: {
          routesRoot: join(directory, "routes"),
          factory: join(directory, "application.ts"),
        },
      }).application;
      await assert.rejects(
        createConfiguredApplication({
          config,
          signal: control.controller.signal,
        }),
        /factory_cancelled/,
      );
      assert.deepEqual(control.application.snapshot(), {
        acceptingRequests: false,
        activeRequests: 0,
      });
      await control.application.dispose();
    },
  );
});
