import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { loadConfig } from "./src/config/load.ts";
import { startServer } from "./src/server/server.ts";
import { resolveRouter } from "./src/runtime/router_resolver.ts";

if (import.meta.main) {
  const args = parse(Deno.args, {
    string: ["config", "source", "port"],
    boolean: ["help"],
    alias: { h: "help" },
    default: {},
  });

  const cmd = args._[0] as string | undefined;

  if (args.help) {
    console.log(`Oxian CLI\n\nUsage:\n  deno run -A cli.ts [--config=oxian.config.ts] [--port=8080] [--source=...]\n\nCommands:\n  routes        Print resolved routes\n  start         Start server (same as default)\n  dev           Start server with dev options (watch, hot-reload)\n`);
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
    await runDev(config, source);
    Deno.exit(0);
  }

  // start/dev default to starting the server
  await startServer({ config, source });
} 