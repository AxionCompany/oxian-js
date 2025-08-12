import type { EffectiveConfig } from "../config/types.ts";
import { clearModuleCache } from "../runtime/module_loader.ts";

export async function runDev(config: EffectiveConfig, source?: string) {
  const watcher = Deno.watchFs([config.root ?? Deno.cwd()], { recursive: true });
  console.log("Dev mode: watching for changes...");

  for await (const ev of watcher) {
    console.log("Change detected, clearing module cache");
    clearModuleCache();
  }
} 