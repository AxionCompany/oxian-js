import type { EffectiveConfig } from "../config/types.ts";
import { createLazyRouter } from "./lazy_router.ts";
import { buildEagerRouter } from "./eager_router.ts";
import type { Resolver } from "../resolvers/types.ts";

export type ResolvedRouter = {
  router: { routes: Array<{ pattern: string }>; match: (path: string) => { route: { pattern: string; fileUrl: URL }; params: Record<string, string> } | null } & { __asyncMatch?: (path: string) => Promise<{ route: { pattern: string; fileUrl: URL }; params: Record<string, string> } | null> };
  loaderManager: { getLoaders: () => unknown[] };
  isRemote: boolean;
  routesRootUrl?: URL;
};

export async function resolveRouter({ config }: { config: EffectiveConfig }, resolver: Resolver): Promise<ResolvedRouter> {
  const routesDir = config.routing?.routesDir ?? "routes";
  const discovery = config.routing?.discovery ?? "eager";

  const routesRootUrl = await resolver.resolve(routesDir);

  const isRemote = routesRootUrl.protocol !== "file:";

  if (discovery === "lazy") {
    const router = await createLazyRouter({ routesRootUrl, listDir: resolver.listDir, stat: resolver.stat, resolve: resolver.resolve });
    return { router: router as unknown as ResolvedRouter["router"], loaderManager: { getLoaders: () => [] }, isRemote, routesRootUrl };
  }

  const router = await buildEagerRouter({ routesRootUrl, listDir: resolver.listDir, stat: resolver.stat });
  return { router: router as unknown as ResolvedRouter["router"], loaderManager: { getLoaders: () => [] }, isRemote, routesRootUrl };
}

