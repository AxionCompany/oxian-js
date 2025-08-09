import { dirname, join, fromFileUrl, toFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";

export type PipelineFiles = {
  dependencyFiles: URL[];
  middlewareFiles: URL[];
  interceptorFiles: URL[];
};

export async function discoverPipelineFilesGeneric(
  chain: Array<string | URL>,
  statFile: (urlOrPath: string | URL) => Promise<boolean>,
): Promise<PipelineFiles> {
  const files: PipelineFiles = { dependencyFiles: [], middlewareFiles: [], interceptorFiles: [] };
  for (const level of chain) {
    const deps = typeof level === "string" ? join(level, "dependencies.ts") : new URL("dependencies.ts", level);
    const mw = typeof level === "string" ? join(level, "middleware.ts") : new URL("middleware.ts", level);
    const ic = typeof level === "string" ? join(level, "interceptors.ts") : new URL("interceptors.ts", level);

    if (await statFile(deps)) files.dependencyFiles.push(typeof deps === "string" ? toFileUrl(deps) : deps);
    if (await statFile(mw)) files.middlewareFiles.push(typeof mw === "string" ? toFileUrl(mw) : mw);
    if (await statFile(ic)) files.interceptorFiles.push(typeof ic === "string" ? toFileUrl(ic) : ic);
  }
  return files;
}

export function buildLocalChain(root: string, routesDir: string, routeFileUrl: URL): string[] {
  const routesRoot = join(root, routesDir);
  const routeFilePath = fromFileUrl(routeFileUrl);
  let curDir = dirname(routeFilePath);
  const chain: string[] = [];
  while (curDir.startsWith(routesRoot)) {
    chain.push(curDir);
    const parent = dirname(curDir);
    if (parent === curDir) break;
    curDir = parent;
  }
  chain.reverse();
  return chain;
}

export function buildRemoteChain(routesRootUrl: URL, routeFileUrl: URL): URL[] {
  const basePath = routesRootUrl.pathname.endsWith("/") ? routesRootUrl.pathname : routesRootUrl.pathname + "/";
  if (!routeFileUrl.pathname.startsWith(basePath)) return [];
  const rel = routeFileUrl.pathname.slice(basePath.length);
  const parts = rel.split("/").filter(Boolean);
  const chain: URL[] = [];
  let current = new URL(routesRootUrl.toString().endsWith("/") ? routesRootUrl : new URL(routesRootUrl.toString() + "/"));
  for (let i = 0; i < parts.length - 1; i++) {
    current = new URL(parts[i] + "/", current);
    chain.push(new URL(current.toString()));
  }
  return chain;
} 