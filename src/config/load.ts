import { join, toFileUrl } from "@std/path";
import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from "@std/path";
import type { OxianConfig, EffectiveConfig } from "./types.ts";
import { createLoaderManager } from "../loader/index.ts";
import { importModule } from "../runtime/importer.ts";
import { dirname } from "@std/path";

const DEFAULTS: Required<Pick<OxianConfig, "root" | "basePath" | "server" | "logging">> = {
  root: Deno.cwd(),
  basePath: "/",
  server: { port: 8080 },
  logging: { level: "info", requestIdHeader: undefined as unknown as string },
};

function fileExists(path: string): Promise<boolean> {
  return Deno.stat(path).then(() => true).catch(() => false);
}

async function findConfigPath(explicit?: string): Promise<string | undefined> {
  if (explicit) {
    // If it looks like a URL scheme we return as-is for loader
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(explicit)) return explicit;
    // Ensure absolute path for toFileUrl (Windows-aware)
    if (pathIsAbsolute(explicit)) return explicit;
    return join(Deno.cwd(), explicit);
  }
  const candidates = [
    "oxian.config.ts",
    "oxian.config.js",
    "oxian.config.mjs",
    "oxian.config.json",
  ];
  for (const name of candidates) {
    const p = join(Deno.cwd(), name);
    if (await fileExists(p)) return p;
  }
  return undefined;
}

async function loadFromModule(path: string): Promise<OxianConfig> {
  const rootForLoader = pathIsAbsolute(path) ? dirname(path) : Deno.cwd();
  const lm = createLoaderManager(rootForLoader);
  const url = lm.resolveUrl(path);
  const mod = await importModule(url, lm.getLoaders(), 60_000, Deno.cwd());
  const exp = (mod.default ?? (mod as any).config ?? mod) as unknown;
  if (typeof exp === "function") {
    // Pass defaults for easy modification (Next.js-like DX)
    const result = await (exp as Function)({ ...DEFAULTS });
    if (typeof result !== "object" || result === null) {
      throw new Error(`Config function in ${path} did not return an object`);
    }
    return result as OxianConfig;
  }
  if (typeof exp !== "object" || exp === null) {
    throw new Error(`Invalid config export in ${path}`);
  }
  return exp as OxianConfig;
}

async function loadFromJson(path: string): Promise<OxianConfig> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as OxianConfig;
}

async function loadRemoteConfig(pathOrUrl: string): Promise<OxianConfig> {
  const lm = createLoaderManager(Deno.cwd());
  const url = lm.resolveUrl(pathOrUrl);
  const loader = lm.getActiveLoader(url);
  // JSON via loader directly
  if (url.pathname.endsWith(".json")) {
    const { content } = await loader.load(url);
    return JSON.parse(content) as OxianConfig;
  }
  // TS/JS modules via bundling importer (supports http/github)
  const mod = await importModule(url, lm.getLoaders(), 60_000, Deno.cwd());
  const exp = (mod.default ?? (mod as any).config ?? mod) as unknown;
  if (typeof exp === "function") {
    const result = await (exp as Function)({ ...DEFAULTS });
    if (typeof result !== "object" || result === null) throw new Error("Config function did not return an object");
    return result as OxianConfig;
  }
  if (typeof exp !== "object" || exp === null) throw new Error("Invalid remote config export");
  return exp as OxianConfig;
}

function applyEnvOverrides(config: OxianConfig): OxianConfig {
  const portFromEnv = Deno.env.get("PORT") ?? Deno.env.get("OXIAN_PORT");
  if (portFromEnv) {
    const n = Number(portFromEnv);
    if (!Number.isNaN(n)) {
      config.server = config.server ?? {};
      config.server.port = n;
    }
  }
  return config;
}

export async function loadConfig(opts: { configPath?: string } = {}): Promise<EffectiveConfig> {
  const configPath = await findConfigPath(opts.configPath);
  let userConfig: OxianConfig = {};
  if (configPath) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(configPath)) {
      userConfig = await loadRemoteConfig(configPath);
    } else if (configPath.endsWith(".json")) {
      userConfig = await loadFromJson(configPath);
    } else {
      userConfig = await loadFromModule(configPath);
    }
  }

  userConfig = applyEnvOverrides(userConfig);

  // Normalize root to an absolute path and expose as a file URL string for consistency
  const cfgRoot = userConfig.root ?? DEFAULTS.root;
  const rootAbs = pathIsAbsolute(cfgRoot) ? cfgRoot : pathResolve(Deno.cwd(), cfgRoot);
  const rootUrlStr = toFileUrl(rootAbs).toString();

  const effective: EffectiveConfig = {
    ...DEFAULTS,
    ...userConfig,
    root: rootUrlStr,
    basePath: userConfig.basePath ?? DEFAULTS.basePath,
    server: { ...DEFAULTS.server, ...(userConfig.server ?? {}) },
    logging: { ...DEFAULTS.logging, ...(userConfig.logging ?? {}) },
  } as EffectiveConfig;

  return effective;
} 