import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import { buildEagerRouter } from "../src/router/eager_router.ts";
import { createLazyRouter } from "../src/router/lazy_router.ts";

type Node = {
  isFile: boolean;
  children?: string[];
};

function createFs(nodes: Record<string, Node>) {
  const normalized = new Map<string, Node>();
  for (const [path, node] of Object.entries(nodes)) {
    normalized.set(path, node);
  }

  const normalize = (url: URL) => {
    const pathname = url.pathname;
    return pathname.endsWith("/") ? pathname : pathname;
  };

  return {
    async listDir(dir: URL): Promise<string[]> {
      const node = normalized.get(normalize(dir));
      return node?.children ?? [];
    },
    async stat(url: URL): Promise<{ isFile: boolean }> {
      const node = normalized.get(normalize(url));
      if (!node) throw new Error(`Missing node for ${url.pathname}`);
      return { isFile: node.isFile };
    },
  };
}

Deno.test("eager router keeps named catch-all params as arrays", async () => {
  const routesRootUrl = new URL("file:///routes/");
  const fs = createFs({
    "/routes/": { isFile: false, children: ["docs"] },
    "/routes/docs": { isFile: false, children: ["[...path].ts"] },
    "/routes/docs/": { isFile: false, children: ["[...path].ts"] },
    "/routes/docs/[...path].ts": { isFile: true },
  });

  const router = await buildEagerRouter({
    routesRootUrl,
    listDir: fs.listDir,
    stat: fs.stat,
  });

  const match = router.match("/docs/getting/started");
  assertExists(match);
  assertEquals(match.route.pattern, "/docs/*");
  assertEquals(match.params.path, ["getting", "started"]);
  assert(!("slug" in match.params));
});

Deno.test("lazy router discovers named catch-all files without slug special-casing", async () => {
  const routesRootUrl = new URL("file:///routes/");
  const fs = createFs({
    "/routes/": { isFile: false, children: ["docs"] },
    "/routes/docs": { isFile: false, children: ["[...path].ts"] },
    "/routes/docs/": { isFile: false, children: ["[...path].ts"] },
    "/routes/docs/[...path].ts": { isFile: true },
  });

  const router = createLazyRouter({
    routesRootUrl,
    listDir: fs.listDir,
    stat: fs.stat,
  });

  const match = await router.__asyncMatch("/docs/getting/started");
  assertExists(match);
  assertEquals(match.route.pattern, "/docs/*");
  assertEquals(match.params.path, ["getting", "started"]);
  assert(!("slug" in match.params));
});
