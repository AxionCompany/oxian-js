import type { EffectiveConfig } from "../config/index.ts";
import { createLazyRouter } from "./lazy_router.ts";
import { buildEagerRouter } from "./eager_router.ts";
import type { Resolver } from "../resolvers/index.ts";
import type { ResolvedRouter } from "./types.ts";

// Re-export types for public API
export type { ResolvedRouter, RouteRecord, RouteMatch, Router } from "./types.ts";

export async function resolveRouter(
  { config }: { config: EffectiveConfig },
  resolver: Resolver,
): Promise<ResolvedRouter> {
  const routesDir = config.routing?.routesDir ?? "routes";
  const discovery = config.routing?.discovery ?? "eager";

  const routesRootUrl = await resolver.resolve(routesDir);

  const isRemote = routesRootUrl.protocol !== "file:";

  if (discovery === "lazy") {
    const router = await createLazyRouter({
      routesRootUrl,
      listDir: resolver.listDir,
      stat: resolver.stat,
    });
    return {
      router: router as unknown as ResolvedRouter["router"],
      loaderManager: { getLoaders: () => [] },
      isRemote,
      routesRootUrl,
    };
  }

  const router = await buildEagerRouter({
    routesRootUrl,
    listDir: resolver.listDir,
    stat: resolver.stat,
  });
  return {
    router: router as unknown as ResolvedRouter["router"],
    loaderManager: { getLoaders: () => [] },
    isRemote,
    routesRootUrl,
  };
}
