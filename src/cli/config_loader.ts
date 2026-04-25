/**
 * @fileoverview Config discovery and resolver factory for the Oxian CLI.
 *
 * Centralises the repeated env-defaults / config-discovery / resolver-creation
 * pattern that was previously duplicated across every CLI code-path.
 *
 * @module cli/config_loader
 */

import { isAbsolute, join, toFileUrl } from "@std/path";
import type { EffectiveConfig, OxianConfig } from "../config/index.ts";
import type { Resolver } from "../resolvers/types.ts";
import { createResolver } from "../resolvers/index.ts";

// ---------------------------------------------------------------------------
// Env defaults (was repeated 6× in old CLI)
// ---------------------------------------------------------------------------

export interface EnvDefaults {
  tokenEnv?: string;
  tokenValue?: string;
  forceReload?: boolean;
}

export function makeEnvDefaults(
  opts: { reload?: boolean } = {},
): EnvDefaults {
  const tokenEnv = (() => {
    try {
      return Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN";
    } catch {
      return "GITHUB_TOKEN";
    }
  })();

  const tokenValue = (() => {
    try {
      return tokenEnv ? Deno.env.get(tokenEnv) : undefined;
    } catch {
      return undefined;
    }
  })();

  return { tokenEnv, tokenValue, forceReload: opts.reload === true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a string that may be a relative/absolute path or a URL into a URL. */
function toUrl(str: string): URL {
  try {
    return new URL(str);
  } catch {
    // Not a valid URL — treat as a file path
    const abs = isAbsolute(str) ? str : join(Deno.cwd(), str);
    return toFileUrl(abs);
  }
}

// ---------------------------------------------------------------------------
// Resolver factory
// ---------------------------------------------------------------------------

export function createResolverFromArgs(
  sourceStr: string | undefined,
  envDefaults: EnvDefaults,
): Resolver {
  return createResolver(
    sourceStr ? toUrl(sourceStr) : undefined,
    envDefaults,
  );
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export function makeDefaultConfig(): EffectiveConfig {
  return {
    root: Deno.cwd(),
    basePath: "/",
    server: {
      port: (() => {
        try {
          return Deno.env.get("PORT") ? Number(Deno.env.get("PORT")) : 8080;
        } catch {
          return 8080;
        }
      })(),
    },
    logging: { level: "info" },
  };
}

// ---------------------------------------------------------------------------
// Config discovery
// ---------------------------------------------------------------------------

/**
 * Discover and merge config from one or more base URLs (config path, source).
 * Returns the merged EffectiveConfig and the resolver used for the last base.
 */
export async function discoverConfig(opts: {
  bases: Array<string | undefined>;
  envDefaults: EnvDefaults;
  portOverride?: number;
  routesDirOverride?: string;
}): Promise<{ config: EffectiveConfig; resolver: Resolver }> {
  let config = makeDefaultConfig();
  let resolver: Resolver | undefined;

  for (const base of opts.bases) {
    resolver = createResolver(base ? toUrl(base) : undefined, opts.envDefaults);

    const candidates = [
      "oxian.config.ts",
      "oxian.config.js",
      "oxian.config.mjs",
      "oxian.config.json",
    ];

    let discovered: Partial<OxianConfig> | undefined;

    for (const name of candidates) {
      try {
        const mod = await resolver.import(name);
        const pick = (mod.default ?? (mod as { config?: unknown }).config ??
          mod) as unknown;
        if (typeof pick === "function") {
          const fn = pick as (
            defaults: Partial<OxianConfig>,
          ) => Partial<OxianConfig> | Promise<Partial<OxianConfig>>;
          discovered = await fn({ ...config });
        } else if (pick && typeof pick === "object") {
          discovered = pick as Partial<OxianConfig>;
        } else {
          discovered = undefined;
        }
        throw new Error("__done__");
      } catch (e) {
        if ((e as Error)?.message === "__done__") break;
        if ((e as Error)?.message.startsWith("Module not found")) break;
        // continue to next candidate
      }
    }

    // Shallow overlay: remote overrides local
    if (discovered && typeof discovered === "object") {
      const d = discovered;
      config = {
        ...config,
        ...(d.root ? { root: d.root } : { root: undefined }),
        ...(d.basePath ? { basePath: d.basePath } : { basePath: undefined }),
        ...(d.logging
          ? { logging: { ...config.logging, ...d.logging } }
          : {}),
        ...(d.routing
          ? { routing: { ...config.routing, ...d.routing } }
          : {}),
        ...(d.runtime
          ? { runtime: { ...config.runtime, ...d.runtime } }
          : {}),
        ...(d.security
          ? { security: { ...config.security, ...d.security } }
          : {}),
        ...(d.loaders
          ? { loaders: { ...config.loaders, ...d.loaders } }
          : {}),
        ...(d.web ? { web: { ...config.web, ...d.web } } : {}),
        ...(d.prepare ? { prepare: d.prepare } : {}),
        ...(d.compatibility
          ? { compatibility: { ...config.compatibility, ...d.compatibility } }
          : {}),
        server: {
          port: opts.portOverride ?? d.server?.port ?? config.server.port,
        },
      } as EffectiveConfig;
    }
  }

  // Ensure we always have a resolver
  if (!resolver) {
    resolver = createResolverFromArgs(undefined, opts.envDefaults);
  }

  // Apply CLI overrides that come after config discovery
  if (opts.portOverride !== undefined && !Number.isNaN(opts.portOverride)) {
    config = {
      ...config,
      server: { ...config.server, port: opts.portOverride },
    } as EffectiveConfig;
  }

  if (opts.routesDirOverride) {
    config = {
      ...config,
      routing: { ...config.routing, routesDir: opts.routesDirOverride },
    } as EffectiveConfig;
  }

  if (!config.loaders?.github?.tokenEnv) {
    try {
      const ghToken = Deno.env.get("GITHUB_TOKEN");
      if (ghToken) {
        config = {
          ...config,
          loaders: {
            ...config.loaders,
            github: { tokenEnv: "GITHUB_TOKEN", token: ghToken },
          },
        } as EffectiveConfig;
      }
    } catch { /* no env access */ }
  }

  return { config, resolver };
}
