import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { createFileRouter } from "../../src/router/file_router.ts";

type FixtureFiles = Readonly<Record<string, string>>;

async function withFixture(
  files: FixtureFiles,
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "oxian_router_" });
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const absolutePath = join(root, relativePath);
      const separator = absolutePath.lastIndexOf("/");
      await Deno.mkdir(absolutePath.slice(0, separator), { recursive: true });
      await Deno.writeTextFile(absolutePath, source);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const GET_ROUTE = `export const GET = () => new Response("ok");`;
const MIDDLEWARE =
  `export const middleware = async (_request, _context, next) => await next();`;

function relativeModulePath(fileUrl: string, rootUrl: string): string {
  const rootPath = new URL(rootUrl).pathname;
  return decodeURIComponent(new URL(fileUrl).pathname.slice(rootPath.length));
}

Deno.test("v0.20 file router matches static, param, and one-or-more catchall routes by precedence", async () => {
  await withFixture(
    {
      "_middleware.ts": MIDDLEWARE,
      "[...path].ts": GET_ROUTE,
      "[id]/baz.ts": GET_ROUTE,
      "users/_middleware.ts": MIDDLEWARE,
      "users/[id].ts": GET_ROUTE,
      "users/new.ts": GET_ROUTE,
    },
    async (root) => {
      const router = await createFileRouter({ root });

      const staticMatch = router.match("/users/new");
      assert(staticMatch);
      assertEquals(staticMatch.route.pattern, "/users/new");
      assertEquals(staticMatch.params, {});
      assertEquals(
        staticMatch.middlewares.map(({ fileUrl }) =>
          relativeModulePath(fileUrl, router.root)
        ),
        ["_middleware.ts", "users/_middleware.ts"],
      );

      const paramMatch = router.match("/users/alice%20smith");
      assert(paramMatch);
      assertEquals(paramMatch.route.pattern, "/users/:id");
      assertEquals(paramMatch.params, { id: "alice smith" });

      // A static branch may fail deeper; matching then falls back to the
      // parameter branch at the same depth.
      const fallbackMatch = router.match("/foo/baz");
      assert(fallbackMatch);
      assertEquals(fallbackMatch.route.pattern, "/:id/baz");
      assertEquals(fallbackMatch.params, { id: "foo" });

      const catchallMatch = router.match("/users/new/details");
      assert(catchallMatch);
      assertEquals(catchallMatch.route.pattern, "/*path");
      assertEquals(catchallMatch.params, {
        path: ["users", "new", "details"],
      });

      assertEquals(router.match("/"), null);
      assertEquals(router.match("/?query=ignored"), null);
      assertEquals(router.match("/users/new?query=ignored#hash"), staticMatch);
      assertThrows(
        () => router.match("/users/%ZZ"),
        URIError,
        "Malformed URL path",
      );
    },
  );
});

Deno.test("v0.20 file router compiles index routes and immutable method maps", async () => {
  await withFixture(
    {
      "index.ts": `
        export const GET = () => new Response("root");
        export const POST = () => new Response("posted");
        export const QUERY = () => new Response("queried");
        export const description = "auxiliary exports are allowed";
      `,
      "projects/index.ts": GET_ROUTE,
      "projects/[projectId]/index.ts": GET_ROUTE,
    },
    async (root) => {
      const router = await createFileRouter({ root });

      assertEquals(
        router.routes.map(({ pattern }) => pattern),
        ["/", "/projects", "/projects/:projectId"],
      );

      const rootMatch = router.match("/");
      assert(rootMatch);
      assertEquals(Object.keys(rootMatch.route.methods), [
        "GET",
        "POST",
        "QUERY",
      ]);
      assert(typeof rootMatch.route.methods.GET === "function");
      assert(typeof rootMatch.route.methods.POST === "function");
      assert(typeof rootMatch.route.methods.QUERY === "function");

      const projectMatch = router.match("/projects/p-123/");
      assert(projectMatch);
      assertEquals(projectMatch.params, { projectId: "p-123" });

      assert(Object.isFrozen(router));
      assert(Object.isFrozen(router.routes));
      assert(Object.isFrozen(rootMatch.route));
      assert(Object.isFrozen(rootMatch.route.segments));
      assert(Object.isFrozen(rootMatch.route.methods));
      assert(Object.isFrozen(rootMatch.params));
      assert(Object.isFrozen(rootMatch.middlewares));
    },
  );
});

Deno.test("v0.20 file router preserves route-specific names on shared parameter prefixes", async () => {
  await withFixture(
    {
      "[accountId]/profile.ts": GET_ROUTE,
      "[workspaceId]/settings.ts": GET_ROUTE,
    },
    async (root) => {
      const router = await createFileRouter({ root });

      const profile = router.match("/acct-1/profile");
      assert(profile);
      assertEquals(profile.params, { accountId: "acct-1" });

      const settings = router.match("/work-2/settings");
      assert(settings);
      assertEquals(settings.params, { workspaceId: "work-2" });
    },
  );
});

Deno.test("v0.20 file router returns frozen catchall values and stable root-to-leaf middleware", async () => {
  await withFixture(
    {
      "_middleware.ts": MIDDLEWARE,
      "docs/_middleware.ts": MIDDLEWARE,
      "docs/[...parts]/_middleware.ts": MIDDLEWARE,
      "docs/[...parts]/index.ts": GET_ROUTE,
    },
    async (root) => {
      const router = await createFileRouter({ root });
      const match = router.match("/docs/guides/getting-started");
      assert(match);

      assertEquals(match.params.parts, ["guides", "getting-started"]);
      assert(Array.isArray(match.params.parts));
      assert(Object.isFrozen(match.params.parts));
      assertEquals(
        match.middlewares.map(({ fileUrl }) =>
          relativeModulePath(fileUrl, router.root)
        ),
        [
          "_middleware.ts",
          "docs/_middleware.ts",
          "docs/[...parts]/_middleware.ts",
        ],
      );
    },
  );
});

Deno.test("v0.20 file router is a startup snapshot and performs no request-time loading", async () => {
  const counterKey = `__oxian_router_load_${crypto.randomUUID()}`;
  const counterSource = (body: string) => `
    const state = globalThis as unknown as Record<string, number>;
    state[${JSON.stringify(counterKey)}] = (state[${
    JSON.stringify(counterKey)
  }] ?? 0) + 1;
    export const GET = () => new Response(${JSON.stringify(body)});
  `;

  await withFixture(
    { "stable.ts": counterSource("original") },
    async (root) => {
      const state = globalThis as unknown as Record<string, number>;
      try {
        const router = await createFileRouter({ root });
        assertEquals(state[counterKey], 1);
        assertEquals(router.routes.length, 1);

        await Deno.writeTextFile(
          join(root, "stable.ts"),
          counterSource("replacement"),
        );
        await Deno.writeTextFile(join(root, "later.ts"), GET_ROUTE);

        for (let attempt = 0; attempt < 10; attempt++) {
          const match = router.match("/stable");
          assert(match);
          assertEquals(match.route.pattern, "/stable");
        }

        assertEquals(state[counterKey], 1);
        assertEquals(router.routes.length, 1);
        assertEquals(router.match("/later"), null);
        assertMatch(router.root, /^file:.*\/$/);

        await Deno.remove(join(root, "stable.ts"));
        assert(router.match("/stable"));
      } finally {
        delete state[counterKey];
      }
    },
  );
});
