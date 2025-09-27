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
import { fromFileUrl } from "@std/path";
import { startServer } from "./src/server/server.ts";
import { resolveRouter } from "./src/router/index.ts";
import { printBanner } from "./src/cli/banner.ts";
import type { EffectiveConfig, OxianConfig } from "./src/config/types.ts";
import type { Resolver } from "./src/resolvers/types.ts";
import { createResolver } from "./src/resolvers/index.ts";

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

  const port = typeof args.port === "string" ? Number(args.port) : undefined;
  const sourceStr = typeof args.source === "string" ? args.source : undefined;
  const configStr = typeof args.config === "string" ? args.config : undefined;


  let config: EffectiveConfig = {
    root: Deno.cwd(),
    basePath: "/",
    server: { port: (Deno.env.get("PORT") ? Number(Deno.env.get("PORT")) : 8080) },
    logging: { level: "info" }
  };

  const bases = [configStr]
  if (sourceStr) {
    bases.push(sourceStr);
  }

  let resolver: Resolver | undefined;

  try {
    const envDefaults: { tokenEnv?: string; tokenValue?: string } = { tokenEnv: Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN" };
    envDefaults.tokenValue = envDefaults.tokenEnv ? Deno.env.get(envDefaults.tokenEnv) : undefined;

    let discovered: Partial<OxianConfig> | undefined;

    for (const base of bases) {
      resolver = createResolver(base ? new URL(base) : undefined, envDefaults);

      const prevDiscovered = discovered;
      // Resolve repository root-ish for github and http(by path), then try well-known config names
      const candidates = [
        "oxian.config.ts",
        "oxian.config.js",
        "oxian.config.mjs",
        "oxian.config.json",
      ];

      for (const name of candidates) {
        try {
          const mod = await resolver.import(name);
          const pick = (mod.default ?? (mod as { config?: unknown }).config ?? mod) as unknown;
          if (typeof pick === "function") {
            const fn = pick as (defaults: Partial<OxianConfig>) => Partial<OxianConfig> | Promise<Partial<OxianConfig>>;
            const res = await fn({ ...config });
            discovered = res as Partial<OxianConfig>;
          } else if (pick && typeof pick === "object") {
            discovered = pick as Partial<OxianConfig>;
          } else {
            discovered = undefined;
          }
          throw new Error("__done__");
        } catch (e) {
          if ((e as Error)?.message === "__done__") break;
          if ((e as Error)?.message.startsWith("Module not found")) break;
          // continue to next candidate
        }
      }
      // Shallow overlay: remote overrides local
      if (discovered && typeof discovered === "object") {
        const d = discovered as Partial<OxianConfig>;
        config = {
          ...config,
          ...(d.root ? { root: d.root } : { root: undefined }),
          ...(d.basePath ? { basePath: d.basePath } : { basePath: undefined }),
          ...(d.logging ? { logging: { ...config.logging, ...d.logging } } : {}),
          ...(d.routing ? { routing: { ...config.routing, ...d.routing } } : {}),
          ...(d.runtime ? { runtime: { ...config.runtime, ...d.runtime } } : {}),
          ...(d.security ? { security: { ...config.security, ...d.security } } : {}),
          ...(d.loaders ? { loaders: { ...config.loaders, ...d.loaders } } : {}),
          ...(d.compatibility ? { compatibility: { ...config.compatibility, ...d.compatibility } } : {}),
          server: { port: port ?? d.server?.port ?? config.server.port },
        } as EffectiveConfig;
        if (prevDiscovered) {
          console.log("[cli] applied remote config override", base ?? "local");
        }
      }
    }
  } catch (_) { /* ignore discovery failures */ }

  if (port !== undefined && !Number.isNaN(port)) {
    config = { ...config, server: { ...config.server, port } } as EffectiveConfig;
  }

  if (!config.loaders?.github?.tokenEnv && Deno.env.get("GITHUB_TOKEN")) {
    config = {
      ...config,
      loaders: {
        ...config.loaders,
        github: { tokenEnv: "GITHUB_TOKEN", token: Deno.env.get("GITHUB_TOKEN") }
      }
    } as EffectiveConfig;
  }

  console.log('config for server', bases, config);

  if (cmd === "routes") {
    if (!resolver) {
      const envDefaults: { tokenEnv?: string; tokenValue?: string } = { tokenEnv: Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN" };
      envDefaults.tokenValue = envDefaults.tokenEnv ? Deno.env.get(envDefaults.tokenEnv) : undefined;
      resolver = createResolver(sourceStr ? new URL(sourceStr) : undefined, envDefaults);
    }
    const { router } = await resolveRouter({ config }, resolver);
    console.log("Routes:\n" + router.routes.map((r) => `  ${r.pattern}`).join("\n"));
    Deno.exit(0);
  }

  // hypervisor is the default runner unless explicitly disabled
  const hypervisorArg = args.hypervisor as boolean | string | undefined;
  const hypervisorDisabled = (hypervisorArg === false) || (hypervisorArg === "false");
  const bypassHv = hypervisorDisabled || config.runtime?.hv?.enabled === false;
  if (!bypassHv) {
    const { startHypervisor } = await import("./src/hypervisor/index.ts");
    const baseArgs: string[] = [];
    // forward user-provided Deno CLI config path so child processes resolve import maps automatically
    if (typeof args["deno-config"] === "string") {
      baseArgs.push(`--deno-config=${args["deno-config"]}`);
    }
    // ensure child processes do NOT start the hypervisor again
    console.log('[cli] starting hypervisor', { port: config.server?.port, source: sourceStr, bypassHv });
    if (cmd === "dev") {
      config = { ...config, runtime: { ...config.runtime, hotReload: true } } as EffectiveConfig;
    }
    if (!resolver) {
      const envDefaults2: { tokenEnv?: string; tokenValue?: string } = { tokenEnv: Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN" };
      envDefaults2.tokenValue = envDefaults2.tokenEnv ? Deno.env.get(envDefaults2.tokenEnv) : undefined;
      resolver = createResolver(sourceStr ? new URL(sourceStr) : undefined, envDefaults2);
    }
    await startHypervisor({
      config, baseArgs: [
        ...baseArgs,
        // also forward app-specific flags
        ...Deno.args
          .filter((a) => a.startsWith("--source=") || a.startsWith("--config=") || a.startsWith("--provider=") || a.startsWith("--port="))
          .map((a) => a)
          .concat(["--hypervisor=false"]),
      ]
    }, resolver);
    Deno.exit(0);
  }

  console.log('[cli] starting server', { port: config.server?.port, source: sourceStr })

  // start/dev default to starting the server
  if (!resolver) {
    const envDefaults3: { tokenEnv?: string; tokenValue?: string } = { tokenEnv: Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN" };
    envDefaults3.tokenValue = envDefaults3.tokenEnv ? Deno.env.get(envDefaults3.tokenEnv) : undefined;
    resolver = createResolver(sourceStr ? new URL(sourceStr) : undefined, envDefaults3);
  }
  await startServer({ config, source: sourceStr }, resolver);
} 