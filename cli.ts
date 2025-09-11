/**
 * @fileoverview Main CLI entry point for the Oxian framework.
 * 
 * This module provides the command-line interface for Oxian applications, supporting
 * server startup, development mode, route inspection, and hypervisor mode. It handles
 * argument parsing, configuration loading, and delegates to appropriate server
 * startup mechanisms.
 * 
 * @module cli
 */

import { parseArgs } from "@std/cli/parse-args";
import { loadConfig } from "./src/config/load.ts";
import { fromFileUrl } from "@std/path";
import { startServer } from "./src/server/server.ts";
import { resolveRouter } from "./src/runtime/router_resolver.ts";
import { printBanner } from "./src/cli/banner.ts";

// Helpers for init command (hoisted to module scope for linting)
async function readLocalLLM(): Promise<string> {
  const src = new URL("./llm.txt", import.meta.url);
  // 1) Try reading from filesystem when available
  if (src.protocol === "file:") {
    try {
      return await Deno.readTextFile(fromFileUrl(src));
    } catch {/* fallthrough */ }
  }
  // 2) Try HTTP(S) fetch when running from remote URL
  if (src.protocol === "http:" || src.protocol === "https:") {
    try {
      const res = await fetch(src.toString());
      if (res.ok) return await res.text();
    } catch {/* fallthrough */ }
  }
  // 3) Fallback to raw import (requires raw-imports capability)
  try {
    const { default: content } = await import(src.toString(), { with: { type: "text" } });
    return content as unknown as string;
  } catch (e) {
    throw new Error(`[cli] failed to load llm.txt: ${(e as Error)?.message}`);
  }
}

function deepMergeAppend(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const set = new Set<string | number | boolean | object>([...existing, ...incoming]);
    return Array.from(set as Set<unknown>);
  }
  if (existing && incoming && typeof existing === "object" && typeof incoming === "object") {
    const out: Record<string, unknown> = { ...(existing as Record<string, unknown>) };
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (k in out) out[k] = deepMergeAppend(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  // Prefer existing on conflict for append semantics
  return existing !== undefined ? existing : incoming;
}

async function writeJsonWithPrompt(path: string, newJson: Record<string, unknown>) {
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      const choice = prompt(`File ${path} exists. [a]ppend, [o]verwrite, [c]ancel?`, "c")?.toLowerCase();
      if (choice === "o") {
        await Deno.writeTextFile(path, JSON.stringify(newJson, null, 2) + "\n");
        console.log(`[cli] overwrote ${path}`);
      } else if (choice === "a") {
        try {
          const existingText = await Deno.readTextFile(path);
          const existingJson = JSON.parse(existingText);
          const merged = deepMergeAppend(existingJson, newJson) as Record<string, unknown>;
          await Deno.writeTextFile(path, JSON.stringify(merged, null, 2) + "\n");
          console.log(`[cli] appended/merged into ${path}`);
        } catch (e) {
          console.error(`[cli] failed to merge ${path}:`, (e as Error)?.message);
        }
      } else {
        console.log(`[cli] skipped ${path}`);
      }
      return;
    }
  } catch {
    // not exists → write
  }
  await Deno.writeTextFile(path, JSON.stringify(newJson, null, 2) + "\n");
  console.log(`[cli] wrote ${path}`);
}

async function writeTextWithPrompt(path: string, content: string) {
  try {
    const stat = await Deno.stat(path);
    if (stat.isFile) {
      const choice = prompt(`File ${path} exists. [a]ppend, [o]verwrite, [c]ancel?`, "c")?.toLowerCase();
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


if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["config", "source", "port", "deno-config", "out"],
    boolean: ["help", "hypervisor", "test", "force"],
    alias: { h: "help", hv: "hypervisor", f: "force" },
    default: {
      hypervisor: true,
    },
  });

  const cmd = args._[0] as string | undefined;


  if (args.help) {
    console.log(`Oxian CLI\n\nUsage:\n  deno run -A cli.ts [--config=oxian.config.ts] [--port=8080] [--source=...] [--hypervisor] [--deno-config=path/to/deno.json]\n\nCommands:\n  routes           Print resolved routes\n  start            Start server (same as default)\n  dev              Start server with dev options (watch, hot-reload)\n  init             Initialize project files (oxian.config.json, deno.json, llm.txt)\n  init-llm         Copy llm.txt to your repo (use --out=FILE and --force to overwrite)\n`);
    Deno.exit(0);
  }

  // Handle init before loading config
  if (cmd === "init") {
    try {
      printBanner();
      // Ask for main settings
      const portStr = prompt("Port to listen on?", "8080") ?? "8080";
      const parsedPort = Number(portStr);
      const portVal = Number.isFinite(parsedPort) && parsedPort > 0 ? Math.floor(parsedPort) : 8080;

      const routesDirVal = (prompt("Routes directory?", "routes") ?? "routes").trim() || "routes";

      const levelInput = (prompt("Logging level? [debug|info|warn|error]", "info") ?? "info").trim().toLowerCase();
      const allowedLevels = new Set(["debug", "info", "warn", "error"]);
      const loggingLevelVal = allowedLevels.has(levelInput) ? levelInput : "info";

      // oxian.config.json template
      const oxianConfig: Record<string, unknown> = {
        server: { port: portVal },
        routing: { routesDir: routesDirVal, trailingSlash: "preserve" },
        runtime: { hotReload: true },
        security: { cors: { allowedOrigins: ["*"], allowedHeaders: ["authorization", "content-type"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] } },
        logging: { level: loggingLevelVal, requestIdHeader: "x-request-id", performance: false }
      };

      // deno.json template for apps using oxian-js
      const denoAppJson: Record<string, unknown> = {
        imports: {
          "@oxian/oxian-js": "jsr:@oxian/oxian-js"
        },
        tasks: {
          dev: "deno run -A --env -r jsr:@oxian/oxian-js dev",
          start: "deno run -A --env jsr:@oxian/oxian-js start",
          routes: "deno run -A jsr:@oxian/oxian-js routes"
        },
        unstable: ["bare-node-builtins", "detect-cjs", "node-globals", "sloppy-imports", "unsafe-proto", "webgpu", "broadcast-channel", "worker-options", "cron", "kv", "net", "otel", "raw-imports"]
      };

      // llm.txt content from local package
      const llmText = await readLocalLLM();

      await writeJsonWithPrompt("oxian.config.json", oxianConfig);
      await writeJsonWithPrompt("deno.json", denoAppJson);
      await writeTextWithPrompt("llm.txt", llmText);

      console.log("[cli] init completed");
      Deno.exit(0);
    } catch (e) {
      console.error("[cli] init error", (e as Error)?.message);
      Deno.exit(1);
    }
  }

  // Handle init-llm before loading config
  if (cmd === "init-llm") {
    const outPath = typeof args.out === "string" && args.out.trim().length > 0 ? args.out : "llm.txt";
    const force = !!args.force;
    try {
      const src = new URL("./llm.txt", import.meta.url);
      const { default: content } = await import(src.toString(), { with: { type: "text" } });
      const shouldWrite = true;
      try {
        await Deno.stat(outPath);
        if (!force) {
          console.error(`[cli] ${outPath} already exists. Use --force to overwrite.`);
          Deno.exit(2);
        }
      } catch { /* not exists */ }
      if (shouldWrite) {
        await Deno.writeTextFile(outPath, content);
        console.log(`[cli] wrote ${outPath}`);
        Deno.exit(0);
      }
    } catch (e) {
      console.error(`[cli] init-llm error`, (e as Error)?.message);
      Deno.exit(1);
    }
  }

  const config = await loadConfig({ configPath: args.config });



  const port = typeof args.port === "string" ? Number(args.port) : undefined;
  if (port !== undefined && !Number.isNaN(port)) {
    config.server = config.server ?? {};
    config.server.port = port;
  }
  const source = typeof args.source === "string" ? args.source : undefined;

  if (!config.loaders?.github?.tokenEnv && Deno.env.get("GITHUB_TOKEN")) {
    config.loaders = {
      ...config.loaders,
      github: { tokenEnv: "GITHUB_TOKEN", token: Deno.env.get("GITHUB_TOKEN") }
    };
  }


  // Remote config auto-discovery when source is remote and no explicit --config provided
  // Attempt to find a remote oxian.config.* adjacent to the source and overlay it
  if (!args.config && source) {
    try {
      const { createLoaderManager } = await import("./src/loader/index.ts");
      const { importModule } = await import("./src/runtime/importer.ts");
      const lm = createLoaderManager(config.root ?? Deno.cwd(), config.loaders?.github?.tokenEnv, (config as any)?.loaders?.github?.token);
      const base = lm.resolveUrl(source);
      // Resolve repository root-ish for github and http(by path), then try well-known config names
      const candidates = [
        "oxian.config.ts",
        "oxian.config.js",
        "oxian.config.mjs",
        "oxian.config.json",
      ];
      // Try base itself, then its parent (for github/tree/.../api to check repo root under that subdir)
      const bases: URL[] = [base];
      try { bases.push(new URL("../", base)); } catch { /* ignore */ }
      let discovered: Record<string, unknown> | undefined;
      for (const b of bases) {
        for (const name of candidates) {
          try {
            let u;
            if (b.protocol === "github:") {
              u = new URL(`${b.protocol}${b.hostname ? b.hostname + '/' : ''}${b.pathname}/${name}`)
            } else {
              u = new URL(name, b)
            }
            const loader = lm.getActiveLoader(u);
            if (u.pathname.endsWith(".json")) {
              const { content } = await loader.load(u);
              discovered = JSON.parse(content) as Record<string, unknown>;
            } else {
              const mod = await importModule(u, lm.getLoaders(), 60_000, Deno.cwd());
              const resolved = (mod as Record<string, unknown>);
              const pick = (resolved.default ?? (resolved as { config?: unknown }).config ?? resolved) as unknown;
              if (typeof pick === "function") {
                const fn = pick as (defaults: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;
                const res = await fn({ ...(config as unknown as Record<string, unknown>) });
                discovered = res as Record<string, unknown>;
              } else {
                discovered = pick as Record<string, unknown>;
              }
            }
            // Shallow overlay: remote overrides local
            if (discovered && typeof discovered === "object") {
              Object.assign(config as Record<string, unknown>, discovered);
              console.log("[cli] applied remote config override", { url: u.toString() });
              throw new Error("__done__");
            }
          } catch (e) {
            if ((e as Error)?.message === "__done__") break;
            // continue to next candidate
          }
        }
      }
    } catch {
      // ignore discovery failures
    }
  }


  if (cmd === "routes") {
    const { router } = await resolveRouter(config, source);
    console.log("Routes:\n" + router.routes.map((r) => `  ${r.pattern}`).join("\n"));
    Deno.exit(0);
  }

  if (cmd === "dev") {
    const { runDev } = await import("./src/cli/dev.ts");
    runDev(config, source);
  }

  // hypervisor is now the default runner unless explicitly disabled
  const hypervisorArg = args.hypervisor as boolean | string | undefined;
  const hypervisorDisabled = (hypervisorArg === false) || (hypervisorArg === "false");
  const bypassHv = hypervisorDisabled || config.runtime?.hv?.enabled === false;
  if (!bypassHv) {
    const { startHypervisor } = await import("./src/server/hypervisor.ts");
    const baseArgs: string[] = [];
    // forward user-provided Deno CLI config path so child processes resolve import maps automatically
    if (typeof args["deno-config"] === "string") {
      baseArgs.push(`--deno-config=${args["deno-config"]}`);
    }
    // ensure child processes do NOT start the hypervisor again
    console.log('[cli] starting hypervisor', { port: config.server?.port, source, bypassHv });
    await startHypervisor(config, [
      ...baseArgs,
      // also forward app-specific flags we already support
      ...Deno.args
        .filter((a) => a.startsWith("--source=") || a.startsWith("--config=") || a.startsWith("--provider=") || a.startsWith("--port="))
        .map((a) => a)
        .concat(["--hypervisor=false"]),
    ]);
    Deno.exit(0);
  }

  console.log('[cli] starting server', { port: config.server?.port, source })

  // start/dev default to starting the server
  await startServer({ config, source });
} 