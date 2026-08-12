import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
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

Deno.test("static adapter serves GET, HEAD, directory indexes, and MIME metadata", async () => {
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
    assertEquals(file.status, 200);
    assertEquals(file.headers.get("content-type"), "text/plain; charset=utf-8");
    assertEquals(file.headers.get("content-length"), "12");
    assertEquals(file.headers.get("cache-control"), "public, max-age=60");
    assert(file.headers.get("etag"));
    assert(file.headers.get("last-modified"));
    assertEquals(await file.text(), "hello static");

    const head = await handler(
      new Request("https://example.test/assets/hello.txt", {
        method: "HEAD",
      }),
    );
    assertEquals(head.status, 200);
    assertEquals(head.body, null);
    assertEquals(head.headers.get("content-length"), "12");

    const index = await handler(
      new Request("https://example.test/assets/docs/"),
    );
    assertEquals(index.headers.get("content-type"), "text/html; charset=utf-8");
    assertEquals(await index.text(), "<h1>docs</h1>");

    const post = await handler(
      new Request("https://example.test/assets/hello.txt", {
        method: "POST",
      }),
    );
    assertEquals(await post.text(), "fallback");
    assertEquals(fallbackCalls, 1);
  });
});

Deno.test("static adapter supports validators and one byte range", async () => {
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
    assert(etag);
    await initial.body?.cancel();

    const notModified = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { "if-none-match": `W/${etag}` },
      }),
    );
    assertEquals(notModified.status, 304);
    assertEquals(notModified.body, null);
    assertEquals(notModified.headers.get("content-length"), null);

    const range = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=6-11" },
      }),
    );
    assertEquals(range.status, 206);
    assertEquals(range.headers.get("content-range"), "bytes 6-11/12");
    assertEquals(range.headers.get("content-length"), "6");
    assertEquals(await range.text(), "static");

    const suffix = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=-5" },
      }),
    );
    assertEquals(await suffix.text(), "tatic");

    const ignoredIfRange = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: {
          range: "bytes=0-1",
          "if-range": '"different"',
        },
      }),
    );
    assertEquals(ignoredIfRange.status, 200);
    assertEquals(await ignoredIfRange.text(), "hello static");

    const unsatisfied = await handler(
      new Request("https://example.test/static/hello.txt", {
        headers: { range: "bytes=99-100" },
      }),
    );
    assertEquals(unsatisfied.status, 416);
    assertEquals(unsatisfied.headers.get("content-range"), "bytes */12");
  });
});

Deno.test("static adapter rejects decoded traversal and symlink escapes", async () => {
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
    assertEquals(traversal.status, 404);

    const backslash = await handler(
      new Request("https://example.test/assets/%5c..%5csecret.txt"),
    );
    assertEquals(backslash.status, 404);

    const symlink = await handler(
      new Request("https://example.test/assets/escaped-secret.txt"),
    );
    assertEquals(symlink.status, 404);
    assertEquals(await symlink.text(), "Not Found");
  });
});

Deno.test("static adapter cannot be retargeted by metadata callbacks", async () => {
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
        assertEquals(path, canonicalPublicPath);
        Deno.renameSync(path, heldPath);
        Deno.symlinkSync(`${outside}/secret.txt`, path);
        return "text/plain";
      },
    })(() => new Response("unreachable"));

    const response = await handler(
      new Request("https://example.test/assets/race.txt"),
    );
    assertEquals(callbackCalls, 1);
    assertEquals(await response.text(), "public bytes");

    const escaped = await handler(
      new Request("https://example.test/assets/race.txt"),
    );
    assertEquals(escaped.status, 404);
    assertEquals(await escaped.text(), "Not Found");
  });
});

Deno.test("static adapter surfaces premature EOF and closes the file", async () => {
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
    assertEquals(response.headers.get("content-length"), "16");
    await assertRejects(
      () => response.arrayBuffer(),
      TypeError,
      "ended before its advertised content length",
    );
    await Deno.remove(changingPath);
  });
});

Deno.test("static adapter falls through misses and closes cancelled files", async () => {
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
    assertEquals(outside.status, 299);
    assertEquals(fallbackUrl, "https://example.test/application");

    const missing = await handler(
      new Request("https://example.test/assets/missing.txt"),
    );
    assertEquals(missing.status, 299);

    const response = await handler(
      new Request("https://example.test/assets/large.bin"),
    );
    assert(response.body);
    const reader = response.body.getReader();
    const first = await reader.read();
    assertEquals(first.done, false);
    await reader.cancel("test complete");
    await Deno.remove(`${root}/large.bin`);
  });
});

Deno.test("static adapter falls through routes before an HTML navigation fallback", async () => {
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
    assertEquals(await exact.text(), "hello static");
    assertEquals(handled, []);

    const regular = await handler(
      new Request("https://example.test/regular-route", {
        headers: {
          accept: "text/html",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    assertEquals(await regular.text(), "regular route");

    const navigation = await handler(
      new Request("https://example.test/auth/google/callback?code=test", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
        },
      }),
    );
    assertEquals(navigation.status, 200);
    assertEquals(
      navigation.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assertEquals(await navigation.text(), "<h1>app shell</h1>");

    const serviceWorkerNavigation = await handler(
      new Request("https://example.test/auth/session-transfer", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assertEquals(serviceWorkerNavigation.status, 200);
    assertEquals(
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
    assertEquals(head.status, 200);
    assertEquals(head.body, null);
    assertEquals(head.headers.get("content-length"), "18");

    const missingAsset = await handler(
      new Request("https://example.test/missing.js", {
        headers: {
          accept: "*/*",
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
        },
      }),
    );
    assertEquals(missingAsset.status, 404);
    assertEquals(await missingAsset.text(), "application miss");

    const ambiguousAsset = await handler(
      new Request("https://example.test/missing.js", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assertEquals(ambiguousAsset.status, 404);
    assertEquals(await ambiguousAsset.text(), "application miss");

    const extensionlessScript = await handler(
      new Request("https://example.test/missing-bundle", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "script",
          "sec-fetch-mode": "no-cors",
        },
      }),
    );
    assertEquals(extensionlessScript.status, 404);
    assertEquals(await extensionlessScript.text(), "application miss");

    const post = await handler(
      new Request("https://example.test/client-route", {
        method: "POST",
        headers: { accept: "text/html" },
      }),
    );
    assertEquals(post.status, 404);
    assertEquals(await post.text(), "application miss");
  });
});

Deno.test("static navigation fallback never masks malformed or traversal paths", async () => {
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
      assertEquals(response.status, 404);
      assertEquals(await response.text(), "application miss");
    }
  });
});

Deno.test("static adapter validates its root, prefix, and index", async () => {
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
