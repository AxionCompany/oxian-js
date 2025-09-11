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
  const lm = createLoaderManager(config.root ?? Deno.cwd(), config.loaders?.github?.tokenEnv, config.loaders?.github?.token);

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
  // Handle GitHub sources robustly by translating to github: scheme
  let routesRoot: URL;

  // Generic URL resolution
  // Ensure we don't reset to host root for http(s)
  if (base.protocol === "github:") {
    const basePath = base.pathname;
    const finalPath = `${basePath}${basePath.endsWith("/") ? "" : "/"}${suffix}`;
    const abs = `github:${finalPath.replace(/^\//, "")}${base.search}`;
    routesRoot = new URL(abs);
  } else {
    const rel = base.toString().endsWith("/") ? suffix : `/${suffix}`;
    routesRoot = new URL(rel.startsWith("/") && (base.protocol === "http:" || base.protocol === "https:") ? `.${rel}` : rel, base);
  }
  const loader = lm.getActiveLoader(routesRoot);

  console.log('ROUTES ROOT', routesRoot);
  if (discovery === "lazy") {
    console.log('CREATING LAZY ROUTER REMOTE');
    const lazy = createLazyRouterRemote(loader, routesRoot) as unknown as Router & { __asyncMatch?: (path: string) => Promise<ReturnType<Router["match"]>> };
    return { router: lazy, loaderManager: lm, isRemote: true, routesRootUrl: routesRoot };
  }

  const remote = await buildRemoteRouter(loader, routesRoot);
  return { router: remote as unknown as Router, loaderManager: lm, isRemote: true, routesRootUrl: routesRoot };
} 