import type { EffectiveConfig } from "../config/types.ts";
import { clearModuleCache } from "../runtime/module_loader.ts";
import { getLocalRootPath } from "../utils/root.ts";

export async function runDev(config: EffectiveConfig, _source?: string) {
  const watcher = Deno.watchFs([getLocalRootPath(config.root)], { recursive: true });
  console.log("Dev mode: watching for changes...");

  for await (const _ev of watcher) {
    console.log("Change detected, clearing module cache");
    clearModuleCache();
  }
} 