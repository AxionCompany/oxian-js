import type { EffectiveConfig } from "../config/types.ts";
import { clearModuleCache } from "../runtime/module_loader.ts";
import { startServer } from "../server/server.ts";

export async function runDev(config: EffectiveConfig, source?: string) {
  const watcher = Deno.watchFs([config.root ?? Deno.cwd()], { recursive: true });
  console.log("Dev mode: watching for changes...");

  // start server
  startServer({ config, source });

  for await (const ev of watcher) {
    if (!ev.paths.some((p) => p.includes("/routes/") || p.endsWith("oxian.config.ts") || p.endsWith("oxian.config.js") || p.endsWith("oxian.config.json"))) continue;
    console.log("Change detected, clearing module cache");
    clearModuleCache();
  }
} 