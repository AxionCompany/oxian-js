import { parseArgs } from "@std/cli/parse-args";
import { loadConfig } from "./src/config/load.ts";
import { startServer } from "./src/server/server.ts";
import { resolveRouter } from "./src/runtime/router_resolver.ts";


if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["config", "source", "port", "deno-config"],
    boolean: ["help", "hypervisor", "test"],
    alias: { h: "help", hv: "hypervisor" },
    default: {},
  });

  const cmd = args._[0] as string | undefined;

  if (args.help) {
    console.log(`Oxian CLI\n\nUsage:\n  deno run -A cli.ts [--config=oxian.config.ts] [--port=8080] [--source=...] [--hypervisor] [--deno-config=path/to/deno.json]\n\nCommands:\n  routes        Print resolved routes\n  start         Start server (same as default)\n  dev           Start server with dev options (watch, hot-reload)\n`);
    Deno.exit(0);
  }

  const config = await loadConfig({ configPath: args.config });


  const port = typeof args.port === "string" ? Number(args.port) : undefined;
  if (port !== undefined && !Number.isNaN(port)) {
    config.server = config.server ?? {};
    config.server.port = port;
  }
  const source = typeof args.source === "string" ? args.source : undefined;

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
  const bypassHv = args.hypervisor === false || config.runtime?.hv?.enabled === false;
  if (!bypassHv) {
    const { startHypervisor } = await import("./src/server/hypervisor.ts");
    const baseArgs: string[] = [];
    // forward user-provided Deno CLI config path so child processes resolve import maps automatically
    if (typeof args["deno-config"] === "string") {
      baseArgs.push(`--deno-config=${args["deno-config"]}`);
    }
    await startHypervisor(config, [
      ...baseArgs,
      // also forward app-specific flags we already support
      ...Deno.args.filter((a) => a.startsWith("--source=") || a.startsWith("--config=") || a.startsWith("--provider=")),
    ]);
    Deno.exit(0);
  }

  console.log('starting server', config, source)

  // start/dev default to starting the server
  await startServer({ config, source });
} 