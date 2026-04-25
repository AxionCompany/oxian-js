/**
 * @fileoverview `oxian init` command — scaffolds project files.
 * @module cli/commands/init
 */

import { fromFileUrl } from "@std/path";
import { printBanner } from "../banner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readLocalLLM(): Promise<string> {
  const src = new URL("../../../llm.txt", import.meta.url);
  // 1) Try reading from filesystem when available
  if (src.protocol === "file:") {
    try {
      return await Deno.readTextFile(fromFileUrl(src));
    } catch { /* fallthrough */ }
  }
  // 2) Try HTTP(S) fetch when running from remote URL
  if (src.protocol === "http:" || src.protocol === "https:") {
    try {
      const res = await fetch(src.toString());
      if (res.ok) return await res.text();
    } catch { /* fallthrough */ }
  }

  // 3) If is jsr: then use the fetch resolver to fetch the file
  if (src.toString().startsWith("jsr:")) {
    const res = await fetch(src.toString());
    if (res.ok) return await res.text();
  }

  // 4) Fallback using resolver importer (supports remote + raw imports)
  try {
    const mod = await import(src.toString());
    const candidate = (mod as { default?: unknown })?.default ?? (mod as unknown);
    if (typeof candidate === "string") return candidate;
    throw new Error(
      `[cli] unexpected llm.txt content type: ${typeof candidate}`,
    );
  } catch (e) {
    throw new Error(`[cli] failed to load llm.txt: ${(e as Error)?.message}`);
  }
}

function deepMergeAppend(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const set = new Set<string | number | boolean | object>([
      ...existing,
      ...incoming,
    ]);
    return Array.from(set as Set<unknown>);
  }
  if (
    existing && incoming && typeof existing === "object" &&
    typeof incoming === "object"
  ) {
    const out: Record<string, unknown> = {
      ...(existing as Record<string, unknown>),
    };
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (k in out) out[k] = deepMergeAppend(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  // Prefer existing on conflict for append semantics
  return existing !== undefined ? existing : incoming;
}

async function writeJsonWithPrompt(
  path: string,
  newJson: Record<string, unknown>,
) {
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      const choice = prompt(
        `File ${path} exists. [a]ppend, [o]verwrite, [c]ancel?`,
        "c",
      )?.toLowerCase();
      if (choice === "o") {
        await Deno.writeTextFile(path, JSON.stringify(newJson, null, 2) + "\n");
        console.log(`[cli] overwrote ${path}`);
      } else if (choice === "a") {
        try {
          const existingText = await Deno.readTextFile(path);
          const existingJson = JSON.parse(existingText);
          const merged = deepMergeAppend(existingJson, newJson) as Record<
            string,
            unknown
          >;
          await Deno.writeTextFile(
            path,
            JSON.stringify(merged, null, 2) + "\n",
          );
          console.log(`[cli] appended/merged into ${path}`);
        } catch (e) {
          console.error(
            `[cli] failed to merge ${path}:`,
            (e as Error)?.message,
          );
        }
      } else {
        console.log(`[cli] skipped ${path}`);
      }
      return;
    }
  } catch {
    // not exists -> write
  }
  await Deno.writeTextFile(path, JSON.stringify(newJson, null, 2) + "\n");
  console.log(`[cli] wrote ${path}`);
}

async function writeTextWithPrompt(path: string, content: string) {
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      const choice = prompt(
        `File ${path} exists. [a]ppend, [o]verwrite, [c]ancel?`,
        "c",
      )?.toLowerCase();
      if (choice === "o") {
        await Deno.writeTextFile(path, content);
        console.log(`[cli] overwrote ${path}`);
      } else if (choice === "a") {
        await Deno.writeTextFile(path, `\n\n${content}`, { append: true });
        console.log(`[cli] appended to ${path}`);
      } else {
        console.log(`[cli] skipped ${path}`);
      }
      return;
    }
  } catch {
    // not exists
  }
  await Deno.writeTextFile(path, content);
  console.log(`[cli] wrote ${path}`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function runInit(): Promise<void> {
  printBanner();
  // Ask for main settings
  const portStr = prompt("Port to listen on?", "8080") ?? "8080";
  const parsedPort = Number(portStr);
  const portVal = Number.isFinite(parsedPort) && parsedPort > 0
    ? Math.floor(parsedPort)
    : 8080;

  const routesDirVal =
    (prompt("Routes directory?", "routes") ?? "routes").trim() || "routes";

  const levelInput =
    (prompt("Logging level? [debug|info|warn|error]", "info") ?? "info")
      .trim().toLowerCase();
  const allowedLevels = new Set(["debug", "info", "warn", "error"]);
  const loggingLevelVal = allowedLevels.has(levelInput)
    ? levelInput
    : "info";

  // oxian.config.json template
  const oxianConfig: Record<string, unknown> = {
    server: { port: portVal },
    routing: { routesDir: routesDirVal, trailingSlash: "preserve" },
    runtime: { hotReload: true },
    security: {
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["authorization", "content-type"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      },
    },
    logging: {
      level: loggingLevelVal,
      requestIdHeader: "x-request-id",
      performance: false,
    },
  };

  // deno.json template for apps using oxian-js
  const denoAppJson: Record<string, unknown> = {
    imports: {
      "@oxianjs": "jsr:@oxian/oxian-js",
    },
    tasks: {
      dev: "deno run -A --env -r jsr:@oxian/oxian-js dev",
      start: "deno run -A --env jsr:@oxian/oxian-js start",
      routes: "deno run -A jsr:@oxian/oxian-js routes",
    },
    unstable: [
      "bare-node-builtins",
      "detect-cjs",
      "node-globals",
      "sloppy-imports",
      "unsafe-proto",
      "webgpu",
      "broadcast-channel",
      "worker-options",
      "cron",
      "kv",
      "net",
      "otel",
      "raw-imports",
    ],
  };

  // llm.txt content from local package
  const llmText = await readLocalLLM();

  await writeJsonWithPrompt("oxian.config.json", oxianConfig);
  await writeJsonWithPrompt("deno.json", denoAppJson);
  await writeTextWithPrompt("llm.txt", llmText);

  // Create quickstart route
  try {
    await Deno.mkdir(routesDirVal, { recursive: true });
  } catch { /* ignore */ }
  const helloRoutePath = `${routesDirVal}/index.ts`;
  const helloRoute =
    `export function GET() {\n  return { message: "Hello, Oxian!" };\n}\n`;
  await writeTextWithPrompt(helloRoutePath, helloRoute);

  console.log("[cli] init completed");
}
