import type { EffectiveConfig } from "../config/types.ts";
import { resolveRouter } from "./router_resolver.ts";
import { loadRouteModule } from "./module_loader.ts";
import { buildLocalChain, buildRemoteChain, discoverPipelineFiles } from "./pipeline_discovery.ts";
import { composeDependencies } from "./dependencies.ts";

export async function warmup(config: EffectiveConfig, source?: string): Promise<void> {
  const resolved = await resolveRouter(config, source);
  const routes = resolved.router.routes as Array<{ pattern: string; fileUrl: URL }>;
  for (const r of routes) {
    try {
      // Prime dependencies/pipeline chain
      if (resolved.isRemote && resolved.routesRootUrl) {
        const chain = buildRemoteChain(resolved.routesRootUrl, r.fileUrl);
        const files = await discoverPipelineFiles(chain, async (urlOrPath) => {
          if (typeof urlOrPath === "string") return false;
          const st = await resolved.loaderManager.getActiveLoader(resolved.routesRootUrl!).stat?.(urlOrPath);
          return !!st?.isFile;
        });
        await composeDependencies(files, {}, resolved.loaderManager.getLoaders());
      } else {
        const chain = buildLocalChain(config.root ?? Deno.cwd(), config.routing?.routesDir ?? "routes", r.fileUrl);
        const files = await discoverPipelineFiles(chain, async (urlOrPath) => {
          if (typeof urlOrPath !== "string") return false;
          try { return (await Deno.stat(urlOrPath)).isFile; } catch { return false; }
        });
        await composeDependencies(files, {}, resolved.loaderManager.getLoaders());
      }
      // Bundle/instantiate route module
      await loadRouteModule(r.fileUrl);
    } catch (_e) {
      // Ignore warmup failures; they will surface at request time
    }
  }
} 