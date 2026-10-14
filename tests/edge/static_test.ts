import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRejects, assertThrows } from "../support/assert.ts";
import { createStaticAdapter } from "../../src/edge/static.ts";

async function withStaticTree(
  run: (root: string, outside: string) => void | Promise<void>,
): Promise<void> {
  const temporary = await Deno.makeTempDir({ prefix: "oxian-edge-static-" });
  const root = `${temporary}/public`;
  const outside = `${temporary}/outside`;
  await Deno.mkdir(`${root}/docs`, { recursive: true });
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(`${root}/index.html`, "<h1>app shell</h1>");
  await Deno.writeTextFile(`${root}/hello.txt`, "hello static");
  await Deno.writeTextFile(`${root}/docs/index.html`, "<h1>docs</h1>");
  await Deno.writeTextFile(`${outside}/secret.txt`, "not public");
  try {
    await run(root, outside);
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
}

test("static adapter serves GET, HEAD, directory indexes, and MIME metadata", async () => {
  await withStaticTree(async (root) => {
    let fallbackCalls = 0;
    const handler = createStaticAdapter({
      root,
      prefix: "/assets",
      index: ["index.html"],
      cacheControl: "public, max-age=60",
    })(() => {
      fallbackCalls++;
      return new Response("fallback");
    });

    const file = await handler(
      new Request("https://example.test/assets/hello.txt"),
    );
    assert.deepStrictEqual(file.status, 200);
    assert.deepStrictEqual(
      file.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.deepStrictEqual(file.headers.get("content-length"), "12");
    assert.deepStrictEqual(
      file.headers.get("cache-control"),
      "public, max-age=60",
    );
    assert.ok(file.headers.get("etag"));
    assert.ok(file.headers.get("last-modified"));
    assert.deepStrictEqual(await file.text(), "hello static");

    const head = await handler(
      new Request("https://example.test/assets/hello.txt", {
        method: "HEAD",
      }),
    );
    assert.deepStrictEqual(head.status, 200);
    assert.deepStrictEqual(head.body, null);
    assert.deepStrictEqual(head.headers.get("content-length"), "12");

    const index = await handler(
      new Request("https://example.test/assets/docs/"),
    );
    assert.deepStrictEqual(
      index.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.deepStrictEqual(await index.text(), "<h1>docs</h1>");

    const post = await handler(
      new Request("https://example.test/assets/hello.txt", {
        method: "POST",
      }),
    );
    assert.deepStrictEqual(await post.text(), "fallback");
    assert.deepStrictEqual(fallbackCalls, 1);
  });
});

test("static adapter supports validators and one byte range", async () => {
  await withStaticTree(async (root) => {
    const handler = createStaticAdapter({
      root,
      prefix: "/static",
      fallthrough: false,
    })(() => new Response("unreachable"));

    const initial = await handler(
      new Request("https://example.test/static/hello.txt"),
    );
    const etag = initial.headers.get("etag");
    assert.ok(etag);
    await initial.body?.cancel();

    const notModified = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { "if-none-match": `W/${etag}` },
      }),
    );
    assert.deepStrictEqual(notModified.status, 304);
    assert.deepStrictEqual(notModified.body, null);
    assert.deepStrictEqual(notModified.headers.get("content-length"), null);

    const range = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=6-11" },
      }),
    );
    assert.deepStrictEqual(range.status, 206);
    assert.deepStrictEqual(range.headers.get("content-range"), "bytes 6-11/12");
    assert.deepStrictEqual(range.headers.get("content-length"), "6");
    assert.deepStrictEqual(await range.text(), "static");

    const suffix = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=-5" },
      }),
    );
    assert.deepStrictEqual(await suffix.text(), "tatic");

    const ignoredIfRange = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: {
          range: "bytes=0-1",
          "if-range": '"different"',
        },
      }),
    );
    assert.deepStrictEqual(ignoredIfRange.status, 200);
    assert.deepStrictEqual(await ignoredIfRange.text(), "hello static");

    const unsatisfied = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=99-100" },
      }),
    );
    assert.deepStrictEqual(unsatisfied.status, 416);
    assert.deepStrictEqual(
      unsatisfied.headers.get("content-range"),
      "bytes */12",
    );
  });
});

test("static adapter rejects decoded traversal and symlink escapes", async () => {
  await withStaticTree(async (root, outside) => {
    await Deno.symlink(
      `${outside}/secret.txt`,
      `${root}/escaped-secret.txt`,
    );
    const handler = createStaticAdapter({
      root,
      prefix: "/assets",
      fallthrough: false,
    })(() => new Response("unreachable"));

    const traversal = await handler(
      new Request(
        "https://example.test/assets/%2e%2e%2foutside%2fsecret.txt",
      ),
    );
    assert.deepStrictEqual(traversal.status, 404);

    const backslash = await handler(
      new Request("https://example.test/assets/%5c..%5csecret.txt"),
    );
    assert.deepStrictEqual(backslash.status, 404);

    const symlink = await handler(
      new Request("https://example.test/assets/escaped-secret.txt"),
    );
    assert.deepStrictEqual(symlink.status, 404);
    assert.deepStrictEqual(await symlink.text(), "Not Found");
  });
});

test("static adapter cannot be retargeted by metadata callbacks", async () => {
  await withStaticTree(async (root, outside) => {
    const publicPath = `${root}/race.txt`;
    const heldPath = `${root}/race-opened.txt`;
    await Deno.writeTextFile(publicPath, "public bytes");
    const canonicalPublicPath = await Deno.realPath(publicPath);

    let callbackCalls = 0;
    const handler = createStaticAdapter({
      root,
      prefix: "/assets",
      fallthrough: false,
      contentType(path) {
        callbackCalls++;
        assert.deepStrictEqual(path, canonicalPublicPath);
        Deno.renameSync(path, heldPath);
        Deno.symlinkSync(`${outside}/secret.txt`, path);
        return "text/plain";
      },
    })(() => new Response("unreachable"));

    const response = await handler(
      new Request("https://example.test/assets/race.txt"),
    );
    assert.deepStrictEqual(callbackCalls, 1);
    assert.deepStrictEqual(await response.text(), "public bytes");

    const escaped = await handler(
      new Request("https://example.test/assets/race.txt"),
    );
    assert.deepStrictEqual(escaped.status, 404);
    assert.deepStrictEqual(await escaped.text(), "Not Found");
  });
});

test("static adapter surfaces premature EOF and closes the file", async () => {
  await withStaticTree(async (root) => {
    const changingPath = `${root}/changing.txt`;
    await Deno.writeTextFile(changingPath, "advertised bytes");

    const handler = createStaticAdapter({
      root,
      prefix: "/assets",
      fallthrough: false,
      contentType(path) {
        Deno.truncateSync(path, 0);
        return "text/plain";
      },
    })(() => new Response("unreachable"));

    const response = await handler(
      new Request("https://example.test/assets/changing.txt"),
    );
    assert.deepStrictEqual(response.headers.get("content-length"), "16");
    await assertRejects(
      () => response.arrayBuffer(),
      TypeError,
      "ended before its advertised content length",
    );
    await Deno.remove(changingPath);
  });
});

test("static adapter falls through misses and closes cancelled files", async () => {
  await withStaticTree(async (root) => {
    const bytes = new Uint8Array(256 * 1024);
    bytes.fill(42);
    await Deno.writeFile(`${root}/large.bin`, bytes);
    let fallbackUrl = "";
    const handler = createStaticAdapter({
      root,
      prefix: "/assets",
    })((request) => {
      fallbackUrl = request.url;
      return new Response("fallback", { status: 299 });
    });

    const outside = await handler(
      new Request("https://example.test/application"),
    );
    assert.deepStrictEqual(outside.status, 299);
    assert.deepStrictEqual(fallbackUrl, "https://example.test/application");

    const missing = await handler(
      new Request("https://example.test/assets/missing.txt"),
    );
    assert.deepStrictEqual(missing.status, 299);

    const response = await handler(
      new Request("https://example.test/assets/large.bin"),
    );
    assert.ok(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.deepStrictEqual(first.done, false);
    await reader.cancel("test complete");
    await Deno.remove(`${root}/large.bin`);
  });
});

test("static adapter falls through routes before an HTML navigation fallback", async () => {
  await withStaticTree(async (root) => {
    const handled: string[] = [];
    const handler = createStaticAdapter({
      root,
      prefix: "/",
      fallback: "index.html",
    })((request) => {
      const pathname = new URL(request.url).pathname;
      handled.push(pathname);
      return pathname === "/regular-route"
        ? new Response("regular route")
        : new Response("application miss", { status: 404 });
    });

    const exact = await handler(
      new Request("https://example.test/hello.txt"),
    );
    assert.deepStrictEqual(await exact.text(), "hello static");
    assert.deepStrictEqual(handled, []);

    const regular = await handler(
      new Request("https://example.test/regular-route", {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    assert.deepStrictEqual(await regular.text(), "regular route");

    const navigation = await handler(
      new Request("https://example.test/auth/google/callback?code=test", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    assert.deepStrictEqual(navigation.status, 200);
    assert.deepStrictEqual(
      navigation.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assert.deepStrictEqual(await navigation.text(), "<h1>app shell</h1>");

    const serviceWorkerNavigation = await handler(
      new Request("https://example.test/auth/session-transfer", {
        headers: {
          accept: "*/*",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assert.deepStrictEqual(serviceWorkerNavigation.status, 200);
    assert.deepStrictEqual(
      await serviceWorkerNavigation.text(),
      "<h1>app shell</h1>",
    );

    const head = await handler(
      new Request("https://example.test/client-route", {
        method: "HEAD",
        headers: {
          accept: "text/html",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    assert.deepStrictEqual(head.status, 200);
    assert.deepStrictEqual(head.body, null);
    assert.deepStrictEqual(head.headers.get("content-length"), "18");

    const missingAsset = await handler(
      new Request("https://example.test/missing.js", {
        headers: {
          accept: "*/*",
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
        },
      }),
    );
    assert.deepStrictEqual(missingAsset.status, 404);
    assert.deepStrictEqual(await missingAsset.text(), "application miss");

    const ambiguousAsset = await handler(
      new Request("https://example.test/missing.js", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assert.deepStrictEqual(ambiguousAsset.status, 404);
    assert.deepStrictEqual(await ambiguousAsset.text(), "application miss");

    const extensionlessScript = await handler(
      new Request("https://example.test/missing-bundle", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
        },
      }),
    );
    assert.deepStrictEqual(extensionlessScript.status, 404);
    assert.deepStrictEqual(
      await extensionlessScript.text(),
      "application miss",
    );

    const jsonFetch = await handler(
      new Request("https://example.test/missing-record", {
        headers: {
          accept: "application/json",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assert.deepStrictEqual(jsonFetch.status, 404);
    assert.deepStrictEqual(await jsonFetch.text(), "application miss");

    const post = await handler(
      new Request("https://example.test/client-route", {
        method: "POST",
        headers: { accept: "text/html" },
      }),
    );
    assert.deepStrictEqual(post.status, 404);
    assert.deepStrictEqual(await post.text(), "application miss");
  });
});

test("static navigation fallback never masks malformed or traversal paths", async () => {
  await withStaticTree(async (root) => {
    const handler = createStaticAdapter({
      root,
      prefix: "/",
      fallback: "index.html",
    })(() => new Response("application miss", { status: 404 }));
    const navigationHeaders = {
      accept: "text/html",
      "sec-fetch-mode": "navigate",
    };

    for (const path of ["/%E0%A4%A", "/%2e%2e%2foutside%2fsecret.txt"]) {
      const response = await handler(
        new Request(`https://example.test${path}`, {
          headers: navigationHeaders,
        }),
      );
      assert.deepStrictEqual(response.status, 404);
      assert.deepStrictEqual(await response.text(), "application miss");
    }
  });
});

test("static adapter validates its root, prefix, and index", async () => {
  await withStaticTree((root) => {
    assertThrows(
      () => createStaticAdapter({ root, prefix: "assets" }),
      TypeError,
      "absolute URL path",
    );
    assertThrows(
      () => createStaticAdapter({ root, index: "../secret" }),
      TypeError,
      "traversal",
    );
    assertThrows(
      () => createStaticAdapter({ root, fallback: "../secret" }),
      TypeError,
      "traversal",
    );
    assertThrows(
      () =>
        createStaticAdapter({
          root: new URL("https://example.test/public"),
        }),
      TypeError,
      "file: protocol",
    );
  });
});
