import type { EffectiveConfig } from "../config/types.ts";
import { buildRouter } from "../router/router.ts";
import type { Router } from "../router/router.ts";
import { buildRemoteRouter } from "../router/remote_router.ts";
import type { RemoteRouter } from "../router/remote_router.ts";
import { createLoaderManager } from "../loader/index.ts";
import { getLocalRootPath } from "../utils/root.ts";
import { createLazyRouterLocal, createLazyRouterRemote } from "../router/lazy_matcher.ts";

export type ResolvedRouter = {
  router: { routes: Array<{ pattern: string }>; match: (path: string) => ReturnType<Router["match"]> | ReturnType<RemoteRouter["match"]> } & { __asyncMatch?: (path: string) => Promise<ReturnType<Router["match"]>> };
  loaderManager: ReturnType<typeof createLoaderManager>;
  isRemote: boolean;
  routesRootUrl?: URL;
};

export async function resolveRouter(config: EffectiveConfig, source?: string): Promise<ResolvedRouter> {
  const routesDir = config.routing?.routesDir ?? "routes";
  const discovery = config.routing?.discovery ?? "eager";
  const lm = createLoaderManager(config.root ?? Deno.cwd(), config.loaders?.github?.tokenEnv);

  if (!source) {
    if (discovery === "lazy") {
      const lazy = createLazyRouterLocal(getLocalRootPath(config.root), routesDir) as unknown as Router & { __asyncMatch?: (path: string) => Promise<ReturnType<Router["match"]>> };
      return { router: lazy, loaderManager: lm, isRemote: false } as ResolvedRouter;
    }
    const router = await buildRouter({ root: getLocalRootPath(config.root), routesDir });
    return { router, loaderManager: lm, isRemote: false } as ResolvedRouter;
  }

  const base = lm.resolveUrl(source);
  const suffix = routesDir.endsWith("/") ? routesDir : routesDir + "/";
  const routesRoot = new URL(base.toString().endsWith("/") ? suffix : `/${suffix}`, base);
  const loader = lm.getActiveLoader(routesRoot);

  if (discovery === "lazy") {
    const lazy = createLazyRouterRemote(loader, routesRoot) as unknown as Router & { __asyncMatch?: (path: string) => Promise<ReturnType<Router["match"]>> };
    return { router: lazy, loaderManager: lm, isRemote: true, routesRootUrl: routesRoot };
  }

  const remote = await buildRemoteRouter(loader, routesRoot);
  return { router: remote as unknown as Router, loaderManager: lm, isRemote: true, routesRootUrl: routesRoot };
} 