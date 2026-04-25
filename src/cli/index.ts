/**
 * @fileoverview Main CLI entry point for the Oxian framework.
 *
 * Thin dispatcher: parses args, loads config once, and delegates to
 * the appropriate command module.
 *
 * @module cli
 */

import { parseArgs } from "@std/cli/parse-args";
import { startServer } from "../server/server.ts";
import { printBanner } from "../cli/banner.ts";
import { makeEnvDefaults, discoverConfig } from "./config_loader.ts";
import { runInit } from "./commands/init.ts";
import { runMaterialize } from "./commands/materialize.ts";
import { runPrepare } from "./commands/prepare.ts";
import { runRoutes } from "./commands/routes.ts";
import type { EffectiveConfig } from "../config/index.ts";

export async function main() {
  const args = parseArgs(Deno.args, {
    string: [
      "config",
      "source",
      "port",
      "deno-config",
      "out",
      "materialize-dir",
      "routes-dir",
    ],
    boolean: [
      "help",
      "hypervisor",
      "test",
      "force",
      "materialize",
      "materialize-refresh",
      "reload",
    ],
    alias: { h: "help", hv: "hypervisor", f: "force", r: "reload" },
    default: {
      hypervisor: true,
    },
  });

  const cmd = args._[0] as string | undefined;

  if (args.help) {
    console.log(
      `Oxian CLI\n\nUsage:\n  deno run -A cli.ts [command] [options]\n\nCommands:\n  routes                   Print resolved routes\n  start|dev                Start server (default)\n  init                     Initialize project files (oxian.config.json, deno.json, llm.txt)\n  init-llm                 Copy llm.txt to your repo (use --out=FILE and --force to overwrite)\n  materialize              Download and extract remote source locally\n\nOptions:\n  --config=PATH            Config file path or URL\n  --source=SPEC            Source path or URL (file:, github:, https:)\n  --port=N                 Port\n  --deno-config=PATH       Forwarded Deno config for workers\n  --materialize            Enable materialize (boolean)\n  --materialize-dir=DIR    Target directory for materialization (default: current dir/.oxian/materialized)\n  --materialize-refresh    Force re-download/extract\n  --reload, -r             Bypass resolver cache and force fresh resolution\n`,
    );
    Deno.exit(0);
  }

  const envDefaults = makeEnvDefaults({ reload: args.reload === true });
  const sourceStr = typeof args.source === "string" ? args.source : undefined;

  // ── Standalone commands (no config discovery needed) ────────────────────

  if (cmd === "materialize") {
    try {
      if (!sourceStr) throw new Error("--source is required for materialize");
      await runMaterialize({
        source: sourceStr,
        materializeDir: typeof args["materialize-dir"] === "string"
          ? args["materialize-dir"]
          : Deno.cwd(),
        materializeRefresh: args["materialize-refresh"] === true,
        envDefaults,
      });
      Deno.exit(0);
    } catch (e) {
      console.error("[cli] materialize error", (e as Error)?.message);
      console.error(e);
      Deno.exit(1);
    }
  }

  if (cmd === "prepare") {
    try {
      await runPrepare({
        source: sourceStr || Deno.cwd(),
        envDefaults,
      });
      Deno.exit(0);
    } catch (e) {
      console.error("[cli] prepare error", (e as Error)?.message);
      Deno.exit(1);
    }
  }

  if (cmd === "init") {
    try {
      await runInit();
      Deno.exit(0);
    } catch (e) {
      console.error("[cli] init error", (e as Error)?.message);
      Deno.exit(1);
    }
  }

  // ── Config-dependent commands ──────────────────────────────────────────

  const configStr = typeof args.config === "string" ? args.config : undefined;
  const port = typeof args.port === "string" ? Number(args.port) : undefined;
  const routesDir = typeof args["routes-dir"] === "string"
    ? args["routes-dir"]
    : undefined;

  const bases: Array<string | undefined> = [configStr];
  if (sourceStr) bases.push(sourceStr);

  let config: EffectiveConfig;
  let resolver;
  try {
    ({ config, resolver } = await discoverConfig({
      bases,
      envDefaults,
      portOverride: port,
      routesDirOverride: routesDir,
    }));
  } catch (e) {
    console.error("[cli] config discovery failed", (e as Error)?.message);
    Deno.exit(1);
  }

  // ── Routes command ─────────────────────────────────────────────────────

  if (cmd === "routes") {
    await runRoutes({ config, resolver });
    Deno.exit(0);
  }

  // ── Hypervisor or direct server ────────────────────────────────────────

  const hypervisorArg = args.hypervisor as boolean | string | undefined;
  const hypervisorDisabled = (hypervisorArg === false) ||
    (hypervisorArg === "false");
  const bypassHv = hypervisorDisabled || config.runtime?.hv?.enabled === false;
  console.log("[cli] bypassHv", bypassHv);
  if (!bypassHv) {
    const { startHypervisor } = await import("../hypervisor/index.ts");
    const { OxianPlugin } = await import("../hypervisor_plugin/index.ts");
    const baseArgs: string[] = [];
    if (typeof args["deno-config"] === "string") {
      baseArgs.push(`--deno-config=${args["deno-config"]}`);
    }
    console.log("[cli] starting hypervisor", {
      port: config.server?.port,
      source: sourceStr,
      bypassHv,
    });
    if (cmd === "dev") {
      config = {
        ...config,
        runtime: { ...config.runtime, hotReload: true },
      } as EffectiveConfig;
    }
    const plugin = new OxianPlugin();
    await startHypervisor({
      config,
      baseArgs: [
        ...baseArgs,
        ...Deno.args
          .filter((a) =>
            a.startsWith("--source=") || a.startsWith("--config=") ||
            a.startsWith("--provider=") || a.startsWith("--port=") ||
            a.startsWith("--reload") || a === "-r"
          )
          .map((a) => a)
          .concat(["--hypervisor=false"]),
      ],
    }, plugin);
    Deno.exit(0);
  }

  console.log("[cli] starting server", {
    port: config.server?.port,
    source: sourceStr,
  });

  await startServer({ config, source: sourceStr }, resolver);
}
