import { test } from "node:test";
import assert from "node:assert/strict";
import { assertThrows } from "../../tests/support/assert.ts";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createFileRouter } from "./file-router.ts";

type FixtureFiles = Readonly<Record<string, string>>;

async function withFixture(
  files: FixtureFiles,
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "oxian router #%-é-"));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const absolutePath = join(root, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, source);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true });
  }
}

const GET_ROUTE = `export const GET = () => new Response("ok");`;
const MIDDLEWARE = `export const middleware = async (_request, _context, next) => await next();`;

function relativeModulePath(fileUrl: string, rootUrl: string): string {
  const rootPath = new URL(rootUrl).pathname;
  return decodeURIComponent(new URL(fileUrl).pathname.slice(rootPath.length));
}

test("v0.20 file router matches static, param, and one-or-more catchall routes by precedence", async () => {
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
      assert.ok(staticMatch);
      assert.deepStrictEqual(staticMatch.route.pattern, "/users/new");
      assert.deepStrictEqual(staticMatch.params, {});
      assert.deepStrictEqual(
        staticMatch.middlewares.map(({ fileUrl }) =>
          relativeModulePath(fileUrl, router.root),
        ),
        ["_middleware.ts", "users/_middleware.ts"],
      );

      const paramMatch = router.match("/users/alice%20smith");
      assert.ok(paramMatch);
      assert.deepStrictEqual(paramMatch.route.pattern, "/users/:id");
      assert.deepStrictEqual(paramMatch.params, { id: "alice smith" });

      // A static branch may fail deeper; matching then falls back to the
      // parameter branch at the same depth.
      const fallbackMatch = router.match("/foo/baz");
      assert.ok(fallbackMatch);
      assert.deepStrictEqual(fallbackMatch.route.pattern, "/:id/baz");
      assert.deepStrictEqual(fallbackMatch.params, { id: "foo" });

      const catchallMatch = router.match("/users/new/details");
      assert.ok(catchallMatch);
      assert.deepStrictEqual(catchallMatch.route.pattern, "/*path");
      assert.deepStrictEqual(catchallMatch.params, {
        path: ["users", "new", "details"],
      });

      assert.deepStrictEqual(router.match("/"), null);
      assert.deepStrictEqual(router.match("/?query=ignored"), null);
      assert.deepStrictEqual(
        router.match("/users/new?query=ignored#hash"),
        staticMatch,
      );
      assertThrows(
        () => router.match("/users/%ZZ"),
        URIError,
        "Malformed URL path",
      );
    },
  );
});

test("v0.20 file router compiles index routes and immutable method maps", async () => {
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

      assert.deepStrictEqual(
        router.routes.map(({ pattern }) => pattern),
        ["/", "/projects", "/projects/:projectId"],
      );

      const rootMatch = router.match("/");
      assert.ok(rootMatch);
      assert.deepStrictEqual(Object.keys(rootMatch.route.methods), [
        "GET",
        "POST",
        "QUERY",
      ]);
      assert.ok(typeof rootMatch.route.methods.GET === "function");
      assert.ok(typeof rootMatch.route.methods.POST === "function");
      assert.ok(typeof rootMatch.route.methods.QUERY === "function");

      const projectMatch = router.match("/projects/p-123/");
      assert.ok(projectMatch);
      assert.deepStrictEqual(projectMatch.params, { projectId: "p-123" });

      assert.ok(Object.isFrozen(router));
      assert.ok(Object.isFrozen(router.routes));
      assert.ok(Object.isFrozen(rootMatch.route));
      assert.ok(Object.isFrozen(rootMatch.route.segments));
      assert.ok(Object.isFrozen(rootMatch.route.methods));
      assert.ok(Object.isFrozen(rootMatch.params));
      assert.ok(Object.isFrozen(rootMatch.middlewares));
    },
  );
});

test("v0.20 file router preserves route-specific names on shared parameter prefixes", async () => {
  await withFixture(
    {
      "[accountId]/profile.ts": GET_ROUTE,
      "[workspaceId]/settings.ts": GET_ROUTE,
    },
    async (root) => {
      const router = await createFileRouter({ root });

      const profile = router.match("/acct-1/profile");
      assert.ok(profile);
      assert.deepStrictEqual(profile.params, { accountId: "acct-1" });

      const settings = router.match("/work-2/settings");
      assert.ok(settings);
      assert.deepStrictEqual(settings.params, { workspaceId: "work-2" });
    },
  );
});

test("v0.20 file router returns frozen catchall values and stable root-to-leaf middleware", async () => {
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
      assert.ok(match);

      assert.deepStrictEqual(match.params.parts, ["guides", "getting-started"]);
      assert.ok(Array.isArray(match.params.parts));
      assert.ok(Object.isFrozen(match.params.parts));
      assert.deepStrictEqual(
        match.middlewares.map(({ fileUrl }) =>
          relativeModulePath(fileUrl, router.root),
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

test("v0.20 file router is a startup snapshot and performs no request-time loading", async () => {
  const counterKey = `__oxian_router_load_${crypto.randomUUID()}`;
  const counterSource = (body: string) => `
    const state = globalThis as unknown as Record<string, number>;
    state[${JSON.stringify(counterKey)}] = (state[${JSON.stringify(
      counterKey,
    )}] ?? 0) + 1;
    export const GET = () => new Response(${JSON.stringify(body)});
  `;

  await withFixture(
    { "stable.ts": counterSource("original") },
    async (root) => {
      const state = globalThis as unknown as Record<string, number>;
      try {
        const router = await createFileRouter({ root });
        assert.deepStrictEqual(state[counterKey], 1);
        assert.deepStrictEqual(router.routes.length, 1);

        await writeFile(join(root, "stable.ts"), counterSource("replacement"));
        await writeFile(join(root, "later.ts"), GET_ROUTE);

        for (let attempt = 0; attempt < 10; attempt++) {
          const match = router.match("/stable");
          assert.ok(match);
          assert.deepStrictEqual(match.route.pattern, "/stable");
        }

        assert.deepStrictEqual(state[counterKey], 1);
        assert.deepStrictEqual(router.routes.length, 1);
        assert.deepStrictEqual(router.match("/later"), null);
        assert.match(router.root, /^file:.*\/$/);

        await rm(join(root, "stable.ts"));
        assert.ok(router.match("/stable"));
      } finally {
        delete state[counterKey];
      }
    },
  );
});

test("file router accepts filesystem paths and file URLs with encoded characters", async () => {
  await withFixture({ "space # % é.mjs": GET_ROUTE }, async (root) => {
    const expectedRoot = `${pathToFileURL(root).href}/`;
    const url = pathToFileURL(root);
    for (const input of [root, relative(process.cwd(), root), url, url.href]) {
      const router = await createFileRouter({ root: input });
      assert.equal(router.root, expectedRoot);
      const match = router.match("/space%20%23%20%25%20%C3%A9");
      assert.ok(match);
      assert.equal(match.route.pattern, "/space # % é");
      assert.equal(
        match.route.fileUrl,
        pathToFileURL(join(root, "space # % é.mjs")).href,
      );
    }
    assert.equal(
      url.href,
      pathToFileURL(root).href,
      "the supplied URL is not mutated",
    );
  });
});

test("file router imports supported modules in deterministic depth-first name order", async () => {
  const key = `__oxian_router_order_${crypto.randomUUID()}`;
  const state = globalThis as unknown as Record<string, string[]>;
  const record = (name: string, source: string) =>
    `globalThis[${JSON.stringify(key)}].push(${JSON.stringify(name)}); ${source}`;
  state[key] = [];
  try {
    await withFixture(
      {
        "z.js": record("z.js", GET_ROUTE),
        "é.ts": record("é.ts", GET_ROUTE),
        "a/leaf.mjs": record("a/leaf.mjs", GET_ROUTE),
        "a/_middleware.ts": record("a/_middleware.ts", MIDDLEWARE),
        "_middleware.mjs": record("_middleware.mjs", MIDDLEWARE),
        "A.mts": record("A.mts", GET_ROUTE),
      },
      async (root) => {
        const router = await createFileRouter({ root });
        assert.deepEqual(state[key], [
          "A.mts",
          "_middleware.mjs",
          "a/_middleware.ts",
          "a/leaf.mjs",
          "z.js",
          "é.ts",
        ]);
        assert.deepEqual(
          router.routes.map(({ pattern }) => pattern),
          ["/A", "/a/leaf", "/z", "/é"],
        );
        assert.equal(router.match("/a/leaf")?.middlewares.length, 2);
      },
    );
  } finally {
    delete state[key];
  }
});

test("file router skips symlink files, symlink directories, private files and unsupported extensions", async () => {
  await withFixture(
    {
      "visible.mjs": GET_ROUTE,
      "nested/index.mjs": GET_ROUTE,
      "_private.mjs": `throw new Error("private file must not load");`,
      "ignored.cjs": `throw new Error("unsupported extension must not load");`,
      "ignored.txt": "not a module",
    },
    async (root) => {
      await symlink(
        join(root, "visible.mjs"),
        join(root, "linked.mjs"),
        "file",
      );
      await symlink(join(root, "nested"), join(root, "linked"), "dir");
      await symlink(join(root, "missing"), join(root, "dangling.mjs"), "file");
      const router = await createFileRouter({ root });
      assert.deepEqual(
        router.routes.map(({ pattern }) => pattern),
        ["/nested", "/visible"],
      );
      assert.equal(router.match("/linked"), null);
      assert.equal(router.match("/_private"), null);
    },
  );
});

test("file router preserves pathname decoding, encoded delimiters and empty-segment semantics", async () => {
  await withFixture({ "value/[id].mjs": GET_ROUTE }, async (root) => {
    const router = await createFileRouter({ root });
    assert.deepEqual(router.match("//value//a%2Fb/?ignored#fragment")?.params, {
      id: "a/b",
    });
    assert.deepEqual(router.match("/value/%252F")?.params, { id: "%2F" });
    assert.deepEqual(router.match("/value/%23%3F")?.params, { id: "#?" });
    assert.deepEqual(router.match("/value/%C3%A9")?.params, { id: "é" });
    assert.equal(router.match("/value/a/b"), null);
  });
});

test("file router rejects missing and non-directory roots", async () => {
  await withFixture({ "index.mjs": GET_ROUTE }, async (root) => {
    await assert.rejects(createFileRouter({ root: join(root, "missing") }));
    await assert.rejects(createFileRouter({ root: join(root, "index.mjs") }));
  });
});
