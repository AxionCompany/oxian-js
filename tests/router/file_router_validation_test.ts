import { assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createFileRouter } from "../../src/router/file_router.ts";

type FixtureFiles = Readonly<Record<string, string>>;

async function withFixture(
  files: FixtureFiles,
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    prefix: "oxian_router_validation_",
  });
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

async function rejectsFixture(
  files: FixtureFiles,
  messageIncludes: string,
): Promise<void> {
  await withFixture(files, async (root) => {
    await assertRejects(
      () => createFileRouter({ root }),
      Error,
      messageIncludes,
    );
  });
}

const GET_ROUTE = `export const GET = () => new Response("ok");`;

Deno.test("v0.20 file router rejects duplicate canonical routes", async () => {
  await rejectsFixture(
    {
      "users.ts": GET_ROUTE,
      "users/index.ts": GET_ROUTE,
    },
    "Duplicate canonical route /users",
  );
});

Deno.test("v0.20 file router rejects structurally ambiguous parameter routes", async () => {
  await rejectsFixture(
    {
      "users/[id].ts": GET_ROUTE,
      "users/[name].ts": GET_ROUTE,
    },
    "Structurally ambiguous route",
  );
});

Deno.test("v0.20 file router rejects non-final catchalls", async () => {
  await rejectsFixture(
    { "docs/[...path]/details.ts": GET_ROUTE },
    "must be final",
  );
});

Deno.test("v0.20 file router rejects route extension collisions before import", async () => {
  await rejectsFixture(
    {
      "health.js": GET_ROUTE,
      "health.ts": GET_ROUTE,
    },
    "extension collision",
  );

  await rejectsFixture(
    {
      "_middleware.js":
        `export const middleware = (_request, _context, next) => next();`,
      "_middleware.ts":
        `export const middleware = (_request, _context, next) => next();`,
      "index.ts": GET_ROUTE,
    },
    "extension collision",
  );
});

Deno.test("v0.20 file router requires named function HTTP exports", async () => {
  await rejectsFixture(
    { "empty.ts": `export const helper = 1;` },
    "must export at least one named HTTP method",
  );

  await rejectsFixture(
    { "wrong.ts": `export const GET = "not a function";` },
    "GET must be a function",
  );

  await rejectsFixture(
    { "default.ts": `export default () => new Response("wrong shape");` },
    "default and all handlers are not supported",
  );

  await rejectsFixture(
    {
      "mixed.ts": `
        export const GET = () => new Response("ok");
        export default () => new Response("ambiguous");
      `,
    },
    "default and all handlers are not supported",
  );

  await rejectsFixture(
    {
      "all.ts": `
        export const GET = () => new Response("ok");
        export const all = () => new Response("ambiguous");
      `,
    },
    "default and all handlers are not supported",
  );
});

Deno.test("v0.20 file router rejects unsupported uppercase method exports", async () => {
  await rejectsFixture(
    {
      "typo.ts": `
        export const GET = () => new Response("ok");
        export const GEET = () => new Response("typo");
      `,
    },
    "Unsupported uppercase HTTP method export GEET",
  );

  await rejectsFixture(
    {
      "connect.ts": `
        export const GET = () => new Response("ok");
        export const CONNECT = "not supported";
      `,
    },
    "Unsupported uppercase HTTP method export CONNECT",
  );
});

Deno.test("v0.20 file router validates every middleware module at startup", async () => {
  await rejectsFixture(
    {
      "_middleware.ts": `export const middleware = 42;`,
      "index.ts": GET_ROUTE,
    },
    "must export a named middleware function",
  );

  await rejectsFixture(
    {
      "_middleware.ts": `export default (_request, _context, next) => next();`,
      "index.ts": GET_ROUTE,
    },
    "must export a named middleware function",
  );
});

Deno.test("v0.20 file router rejects malformed and duplicate parameters", async () => {
  await rejectsFixture(
    { "users/[id.ts": GET_ROUTE },
    "Invalid route segment",
  );

  await rejectsFixture(
    { "[id]/[id].ts": GET_ROUTE },
    'Duplicate route parameter "id"',
  );

  await rejectsFixture(
    { "[__proto__].ts": GET_ROUTE },
    'Invalid route parameter "__proto__"',
  );

  await rejectsFixture(
    { "[...__proto__].ts": GET_ROUTE },
    'Invalid route parameter "__proto__"',
  );

  await rejectsFixture(
    { "[not-valid].ts": GET_ROUTE },
    'Invalid route parameter "not-valid"',
  );
});

Deno.test("v0.20 file router only accepts filesystem roots", async () => {
  await assertRejects(
    () => createFileRouter({ root: new URL("https://example.com/routes/") }),
    TypeError,
    "must use the file: protocol",
  );
});
