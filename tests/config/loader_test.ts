import { assertEquals, assertInstanceOf } from "@std/assert";
import { join, resolve, toFileUrl } from "@std/path";
import { loadConfig } from "../../src/config/config.ts";

const CONFIG_MODULE_URL = new URL(
  "../../src/config/config.ts",
  import.meta.url,
).href;

async function withConfigModule(
  source: string,
  run: (
    input: Readonly<{ directory: string; path: string; url: URL }>,
  ) => void | Promise<void>,
  filename = "oxian.config.ts",
): Promise<void> {
  const directory = await Deno.makeTempDir({
    prefix: "oxian_config_",
  });
  const path = join(directory, filename);
  await Deno.writeTextFile(path, source);
  try {
    await run({
      directory,
      path,
      url: toFileUrl(path),
    });
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function assertTypeErrorMessage(
  run: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await run();
    throw new Error("expected callback to reject");
  } catch (error) {
    assertInstanceOf(error, TypeError);
    assertEquals(error.message, message);
  }
}

Deno.test({
  name:
    "v0.20 loadConfig accepts one default export and rebases local roots to the module",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `
        export default {
          application: {
            routesRoot: "./api",
            basePath: "/api/v1",
            factory: "./application.ts"
          },
          gateway: {
            edge: {
              static: { root: "../public" },
              devProxy: { upstream: "http://localhost:5173" }
            }
          }
        };
      `,
      async ({ directory, path }) => {
        const config = await loadConfig(path);

        assertEquals(
          config.application.routesRoot,
          resolve(directory, "api"),
        );
        assertEquals(config.application.basePath, "/api/v1");
        assertEquals(
          config.application.factory,
          resolve(directory, "application.ts"),
        );
        assertEquals(
          config.gateway.edge?.static?.root,
          resolve(directory, "../public"),
        );
        assertEquals(
          config.gateway.edge?.devProxy?.upstream,
          "http://localhost:5173/",
        );
        assertEquals(config.gateway.edge?.devProxy?.prefix, "/");
        assertEquals(config.gateway.edge?.devProxy?.stripPrefix, false);
        assertEquals(Object.isFrozen(config), true);
        assertEquals(Object.isFrozen(config.gateway.edge?.static), true);
      },
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig accepts one named config export and file URL source",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `export const config = { gateway: { listener: { port: 9090 } } };`,
      async ({ directory, url }) => {
        const config = await loadConfig(url);
        assertEquals(config.gateway.listener.port, 9_090);
        assertEquals(
          config.application.routesRoot,
          resolve(directory, "routes"),
        );
        assertEquals(config.application.basePath, "/");
        assertEquals(config.application.factory, undefined);
      },
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig accepts the result of defineConfig",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `
        import { defineConfig } from ${JSON.stringify(CONFIG_MODULE_URL)};
        export default defineConfig({
          application: {
            routesRoot: "./typed-routes",
            basePath: "/typed",
            factory: "./typed-application.ts"
          },
          gateway: {
            listener: { port: 0 },
            edge: {
              devProxy: {
                upstream: "http://localhost:5173",
                prefix: "/app",
                stripPrefix: true
              }
            }
          }
        });
      `,
      async ({ directory, path }) => {
        const config = await loadConfig(path);
        assertEquals(
          config.application.routesRoot,
          resolve(directory, "typed-routes"),
        );
        assertEquals(config.application.basePath, "/typed");
        assertEquals(
          config.application.factory,
          resolve(directory, "typed-application.ts"),
        );
        assertEquals(config.gateway.listener.port, 0);
        assertEquals(config.gateway.edge?.devProxy?.prefix, "/app");
        assertEquals(config.gateway.edge?.devProxy?.stripPrefix, true);
      },
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig rejects ambiguous and additional exports",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `
        export const config = {};
        export default {};
      `,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          'config module must not export both "default" and "config"',
        );
      },
    );

    await withConfigModule(
      `
        export const helper = 1;
        export default {};
      `,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          'config module may only export "default"; found extra export "helper"',
        );
      },
    );

    await withConfigModule(
      `export const helper = 1;`,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          'config module must export exactly one of "default" or "config"',
        );
      },
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig rejects factories and non-plain exports",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `export default () => ({ gateway: {} });`,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          "config must be a plain object; received function",
        );
      },
    );

    await withConfigModule(
      `export default new URL("file:///tmp/routes");`,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          "config must be a plain object; received object",
        );
      },
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig only accepts local .ts modules",
  permissions: { read: true, write: true },
  async fn() {
    await assertTypeErrorMessage(
      () => loadConfig("https://example.com/oxian.config.ts"),
      "config source must be a local file: URL without a query or fragment",
    );
    await assertTypeErrorMessage(
      () => loadConfig("./oxian.config.json"),
      "config source must be a TypeScript module ending in .ts",
    );
    await assertTypeErrorMessage(
      () => loadConfig("./oxian.config.js"),
      "config source must be a TypeScript module ending in .ts",
    );
    await assertTypeErrorMessage(
      () => loadConfig(new URL("file:///tmp/oxian.config.ts?environment=dev")),
      "config source must be a local file: URL without a query or fragment",
    );
  },
});

Deno.test({
  name: "v0.20 loadConfig performs no merge or environment token expansion",
  permissions: { read: true, write: true },
  async fn() {
    await withConfigModule(
      `
        export default {
          gateway: {
            hypervisor: {
              tokenEnv: "OXIAN_TOKEN"
            }
          }
        };
      `,
      async ({ path }) => {
        await assertTypeErrorMessage(
          () => loadConfig(path),
          'config.gateway.hypervisor contains unknown key "tokenEnv"',
        );
      },
    );
  },
});
