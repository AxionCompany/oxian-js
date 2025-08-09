import { join, toFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";
import { OxianConfig, EffectiveConfig } from "./types.ts";

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
    // Ensure absolute path for toFileUrl
    if (explicit.startsWith("/")) return explicit;
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
  const url = toFileUrl(path).href;
  const mod = await import(url);
  const cfg = (mod.default ?? mod.config ?? mod) as unknown;
  if (typeof cfg !== "object" || cfg === null) {
    throw new Error(`Invalid config export in ${path}`);
  }
  return cfg as OxianConfig;
}

async function loadFromJson(path: string): Promise<OxianConfig> {
  const raw = await Deno.readTextFile(path);
  return JSON.parse(raw) as OxianConfig;
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
    if (configPath.endsWith(".json")) {
      userConfig = await loadFromJson(configPath);
    } else {
      userConfig = await loadFromModule(configPath);
    }
  }

  userConfig = applyEnvOverrides(userConfig);

  const effective: EffectiveConfig = {
    ...DEFAULTS,
    ...userConfig,
    root: userConfig.root ?? DEFAULTS.root,
    basePath: userConfig.basePath ?? DEFAULTS.basePath,
    server: { ...DEFAULTS.server, ...(userConfig.server ?? {}) },
    logging: { ...DEFAULTS.logging, ...(userConfig.logging ?? {}) },
  } as EffectiveConfig;

  return effective;
} 