import { assertEquals } from "@std/assert";
import type { EdgeConfig } from "../../src/config/types.ts";
import { composeConfiguredEdge } from "../../src/local/edge.ts";

async function withWebRoot(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "oxian-local-edge-" });
  await Deno.mkdir(`${root}/api`, { recursive: true });
  await Deno.writeTextFile(`${root}/index.html`, "<h1>compass shell</h1>");
  await Deno.writeTextFile(`${root}/asset.js`, "asset");
  await Deno.writeTextFile(`${root}/api/shadowed`, "static shadow");
  try {
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function navigation(path: string): Request {
  return new Request(`https://example.test${path}`, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
    },
  });
}

Deno.test("configured edge gives a more-specific application mount priority over parent static", async () => {
  await withWebRoot(async (root) => {
    const calls: string[] = [];
    const application = (request: Request): Response => {
      const pathname = new URL(request.url).pathname;
      calls.push(pathname);
      return pathname === "/api/live" || pathname === "/api/shadowed"
        ? new Response(`application:${pathname}`)
        : new Response("application miss", { status: 404 });
    };
    const edge = {
      static: {
        root,
        prefix: "/",
        index: ["index.html"],
        fallback: "index.html",
        cacheControl: "no-cache",
        fallthrough: true,
      },
    } satisfies EdgeConfig;
    const handler = composeConfiguredEdge(application, edge, "start", "/api");

    const api = await handler(navigation("/api/live"));
    assertEquals(await api.text(), "application:/api/live");

    const shadowed = await handler(navigation("/api/shadowed"));
    assertEquals(await shadowed.text(), "application:/api/shadowed");

    const apiMiss = await handler(navigation("/api/unknown"));
    assertEquals(apiMiss.status, 404);
    assertEquals(await apiMiss.text(), "application miss");

    const callback = await handler(
      navigation("/auth/google/callback?code=synthetic&state=synthetic"),
    );
    assertEquals(callback.status, 200);
    assertEquals(await callback.text(), "<h1>compass shell</h1>");

    const serviceWorkerCallback = await handler(
      new Request("https://example.test/auth/google/callback", {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
        },
      }),
    );
    assertEquals(serviceWorkerCallback.status, 200);
    assertEquals(
      await serviceWorkerCallback.text(),
      "<h1>compass shell</h1>",
    );

    const asset = await handler(
      new Request("https://example.test/asset.js"),
    );
    assertEquals(await asset.text(), "asset");

    assertEquals(calls, [
      "/api/live",
      "/api/shadowed",
      "/api/unknown",
    ]);
  });
});

Deno.test("configured edge uses exact segment boundaries for application ownership", async () => {
  await withWebRoot(async (root) => {
    const edge = {
      static: {
        root,
        prefix: "/",
        index: ["index.html"],
        fallback: "index.html",
        fallthrough: true,
      },
    } satisfies EdgeConfig;
    const handler = composeConfiguredEdge(
      () => new Response("application miss", { status: 404 }),
      edge,
      "start",
      "/api",
    );

    assertEquals(
      await (await handler(navigation("/apix"))).text(),
      "<h1>compass shell</h1>",
    );
  });
});

Deno.test("configured edge lets exact static files and regular routes coexist at equal mounts", async () => {
  await withWebRoot(async (root) => {
    const edge = {
      static: {
        root,
        prefix: "/",
        index: ["index.html"],
        fallback: "index.html",
        fallthrough: true,
      },
    } satisfies EdgeConfig;
    const handler = composeConfiguredEdge(
      (request) =>
        new URL(request.url).pathname === "/regular"
          ? new Response("regular route")
          : new Response("application miss", { status: 404 }),
      edge,
      "start",
      "/",
    );

    assertEquals(
      await (await handler(new Request("https://example.test/asset.js")))
        .text(),
      "asset",
    );
    assertEquals(
      await (await handler(navigation("/regular"))).text(),
      "regular route",
    );
    assertEquals(
      await (await handler(navigation("/client-route"))).text(),
      "<h1>compass shell</h1>",
    );
  });
});

Deno.test("configured edge keeps a parent development proxy away from the application mount", async () => {
  const edge = {
    devProxy: {
      upstream: "http://127.0.0.1:1/",
      prefix: "/",
      stripPrefix: false,
      forwardHost: false,
    },
  } satisfies EdgeConfig;
  const handler = composeConfiguredEdge(
    () => new Response("application"),
    edge,
    "dev",
    "/api",
  );

  const response = await handler(
    new Request("https://example.test/api/v1/threads"),
  );
  assertEquals(response.status, 200);
  assertEquals(await response.text(), "application");
});
