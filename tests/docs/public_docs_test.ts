import { assert, assertEquals } from "@std/assert";
import * as denoAdapter from "@oxian/oxian-js/adapters/deno";
import * as app from "@oxian/oxian-js/app";
import * as config from "@oxian/oxian-js/config";
import * as core from "../../src/core.ts";
import * as edge from "@oxian/oxian-js/edge";
import * as http from "@oxian/oxian-js/http";
import * as hypervisor from "@oxian/oxian-js/hypervisor";
import * as router from "@oxian/oxian-js/router";
import * as worker from "@oxian/oxian-js/worker";
import { CLI_COMMANDS } from "../../src/cli/types.ts";

const GETTING_STARTED_CHAPTERS = Object.freeze([
  "../../docs/getting-started/part-1-application/01-first-request.md",
  "../../docs/getting-started/part-1-application/02-real-http-api.md",
  "../../docs/getting-started/part-1-application/03-lifecycle-and-middleware.md",
  "../../docs/getting-started/part-1-application/04-streaming-and-cancellation.md",
  "../../docs/getting-started/part-2-workers/05-separate-worker.md",
  "../../docs/getting-started/part-2-workers/06-another-machine.md",
  "../../docs/getting-started/part-3-platform/07-workers-and-providers.md",
  "../../docs/getting-started/part-3-platform/08-failures-and-production.md",
]);

const API_REFERENCE_MODULES = Object.freeze([
  "../../docs/api/adapters/deno.md",
  "../../docs/api/app.md",
  "../../docs/api/cli.md",
  "../../docs/api/config.md",
  "../../docs/api/edge.md",
  "../../docs/api/http.md",
  "../../docs/api/hypervisor.md",
  "../../docs/api/local.md",
  "../../docs/api/protocol.md",
  "../../docs/api/providers.md",
  "../../docs/api/router.md",
  "../../docs/api/supervisor.md",
  "../../docs/api/transport.md",
  "../../docs/api/work.md",
  "../../docs/api/worker.md",
]);

const PUBLIC_DOCUMENTS = Object.freeze([
  "../../README.md",
  "../../docs/README.md",
  "../../docs/architecture.md",
  "../../docs/getting-started.md",
  ...GETTING_STARTED_CHAPTERS,
  "../../docs/application.md",
  "../../docs/workers.md",
  "../../docs/operations.md",
  "../../docs/runtime-adapters.md",
  "../../docs/api-reference.md",
  ...API_REFERENCE_MODULES,
  "../../docs/migration-0.20.md",
  "../../docs/worker-protocol-v1.md",
]);

async function readPublicDocuments(): Promise<
  readonly Readonly<{ relative: string; url: URL; content: string }>[]
> {
  return await Promise.all(
    PUBLIC_DOCUMENTS.map(async (relative) => {
      const url = new URL(relative, import.meta.url);
      return Object.freeze({
        relative,
        url,
        content: await Deno.readTextFile(url),
      });
    }),
  );
}

function markdownHeadingAnchors(content: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  const occurrences = new Map<string, number>();
  for (const match of content.matchAll(/^#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)) {
    const base = match[1]
      .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    if (base.length === 0) continue;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    anchors.add(occurrence === 0 ? base : `${base}-${occurrence}`);
  }
  return anchors;
}

Deno.test("public documentation imports published symbols", () => {
  assert(typeof denoAdapter.handler === "function");
  assert(typeof denoAdapter.serve === "function");
  assert(typeof app.createApplication === "function");
  assert(typeof app.createServerSentEvents === "function");
  assert(typeof app.defineApplicationFactory === "function");
  assert(typeof config.defineConfig === "function");
  assert(typeof core.createHypervisor === "function");
  assert(typeof core.createWorker === "function");
  assert(typeof edge.createCorsAdapter === "function");
  assert(typeof http.createHttpGateway === "function");
  assert(typeof hypervisor.createHypervisor === "function");
  assert(typeof router.createFileRouter === "function");
  assert(typeof worker.createWorker === "function");
});

Deno.test("API-reference pages match every embeddable package subpath", async () => {
  const packageConfig = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as { exports: Readonly<Record<string, string>> };
  const expected = Object.keys(packageConfig.exports)
    .filter((subpath) => subpath !== "." && subpath !== "./bin")
    .map((subpath) => `../../docs/api/${subpath.slice(2)}.md`)
    .sort();

  assertEquals([...API_REFERENCE_MODULES].sort(), expected);
});

Deno.test("public documentation names every CLI command from the current parser", async () => {
  const documents = await readPublicDocuments();
  const commands = new Set<string>();
  for (const document of documents) {
    for (const match of document.content.matchAll(/\boxian (\w+)/g)) {
      commands.add(match[1]);
    }
  }
  assertEquals([...commands].sort(), [...CLI_COMMANDS].sort());
});

Deno.test("the getting-started curriculum is complete and progressive", async () => {
  const requiredSections = Object.freeze([
    "## The pain",
    "## The solution",
    "## Verify it",
    "## What happened",
    "## What this unlocks",
    "## What's next",
  ]);

  for (const [index, relative] of GETTING_STARTED_CHAPTERS.entries()) {
    const chapter = await Deno.readTextFile(
      new URL(relative, import.meta.url),
    );
    assert(
      chapter.includes(`# Chapter ${index + 1}:`),
      `${relative} must identify its chapter number`,
    );
    for (const section of requiredSections) {
      assert(
        chapter.includes(section),
        `${relative} must contain ${section}`,
      );
    }

    const next = GETTING_STARTED_CHAPTERS[index + 1];
    if (next !== undefined) {
      const nextFilename = next.slice(next.lastIndexOf("/") + 1);
      assert(
        chapter.includes(nextFilename),
        `${relative} must link to ${nextFilename}`,
      );
    }
  }
});

Deno.test("public documentation uses published subpaths and valid local links", async () => {
  const packageConfig = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as {
    version: string;
    exports: Readonly<Record<string, string>>;
  };
  const publishedSubpaths = new Set(Object.keys(packageConfig.exports));
  const documents = await readPublicDocuments();

  for (const document of documents) {
    assert(
      !document.content.includes("../src/"),
      `${document.relative} must not import Oxian internals`,
    );

    for (
      const match of document.content.matchAll(
        /jsr:@oxian\/oxian-js(?:@([^/\s"'`)]+))?(?:\/([a-z][a-z\d-]*(?:\/[a-z][a-z\d-]*)*))?/g,
      )
    ) {
      assertEquals(
        match[1],
        packageConfig.version,
        `${document.relative} must pin the current package version`,
      );
      const subpath = match[2] === undefined ? "." : `./${match[2]}`;
      assert(
        publishedSubpaths.has(subpath),
        `${document.relative} uses unpublished subpath ${subpath}`,
      );
    }

    for (
      const match of document.content.matchAll(
        /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g,
      )
    ) {
      const href = match[1];
      if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        continue;
      }
      const hashIndex = href.indexOf("#");
      const path = hashIndex === -1 ? href : href.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? undefined : href.slice(hashIndex + 1);
      if (path.length > 0 && !path.endsWith(".md")) continue;

      const targetUrl = path.length === 0
        ? document.url
        : new URL(path, document.url);
      if (path.length > 0) await Deno.stat(targetUrl);
      if (fragment === undefined || fragment.length === 0) continue;

      const target = targetUrl.href === document.url.href
        ? document.content
        : await Deno.readTextFile(targetUrl);
      const decodedFragment = decodeURIComponent(fragment);
      assert(
        markdownHeadingAnchors(target).has(decodedFragment),
        `${document.relative} links to missing heading #${decodedFragment} in ${
          path || document.relative
        }`,
      );
    }
  }

  const publishInclude = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as { publish: { include: readonly string[] } };
  assert(
    publishInclude.publish.include.includes("docs/getting-started/**"),
    "the published package must include the complete getting-started guide",
  );
  assert(
    publishInclude.publish.include.includes("docs/api/**"),
    "the published package must include every API-reference module",
  );
});

Deno.test("worker documentation makes ReadyAck and durable replay authoritative", async () => {
  const [protocol, workers] = await Promise.all([
    Deno.readTextFile(
      new URL("../../docs/worker-protocol-v1.md", import.meta.url),
    ),
    Deno.readTextFile(new URL("../../docs/workers.md", import.meta.url)),
  ]);
  assert(
    protocol.includes("durably commits and publishes the Ready transition"),
  );
  assert(protocol.includes("`ready_ack` is authoritative"));
  assert(
    /Only after `ready_ack`\s+does `worker\.whenReady\(\)` resolve/.test(
      workers,
    ),
  );
  assert(
    workers.includes("attemptId: crypto.randomUUID()") === false ||
      workers.indexOf("attemptId: crypto.randomUUID()") <
        workers.indexOf("## HTTP worker manifest"),
  );
  assert(workers.includes("restart reuses that stored handshake ID"));
});

Deno.test("application documentation uses the v0.20 middleware module contract", async () => {
  const application = await Deno.readTextFile(
    new URL("../../docs/application.md", import.meta.url),
  );
  assert(application.includes("routes/_middleware.ts"));
  assert(application.includes("export const middleware"));
  assert(!application.includes("routes/middleware.ts"));
  assert(!application.includes("export default timing"));
});
