import { dirname, fromFileUrl, resolve, toFileUrl } from "@std/path";
import type {
  LoadConfigSource,
  OxianConfig,
  OxianConfigInput,
} from "./types.ts";
import { normalizeConfig } from "./validation.ts";

export const DEFAULT_OXIAN_CONFIG: OxianConfig = normalizeConfig({});

/**
 * Defines and validates a code-first Oxian 0.21 configuration.
 *
 * Relative filesystem paths are intentionally preserved here. When a module is
 * loaded with `loadConfig()`, those paths are resolved against that module's
 * directory.
 */
export function defineConfig(
  input: OxianConfigInput,
): OxianConfig {
  return normalizeConfig(input);
}

function configModuleUrl(source: LoadConfigSource): URL {
  let url: URL;
  if (source instanceof URL) {
    url = new URL(source.href);
  } else if (typeof source === "string" && source.length > 0) {
    if (
      !/^[a-zA-Z]:[\\/]/.test(source) &&
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)
    ) {
      try {
        url = new URL(source);
      } catch {
        throw new TypeError(
          "config source must be a local TypeScript module path or file: URL",
        );
      }
    } else {
      url = toFileUrl(resolve(source));
    }
  } else {
    throw new TypeError(
      "config source must be a local TypeScript module path or file: URL",
    );
  }

  if (
    url.protocol !== "file:" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      "config source must be a local file: URL without a query or fragment",
    );
  }
  if (!url.pathname.endsWith(".ts")) {
    throw new TypeError(
      "config source must be a TypeScript module ending in .ts",
    );
  }
  return url;
}

function selectModuleExport(
  module: Readonly<Record<string, unknown>>,
): unknown {
  const exports = Object.keys(module).sort();
  const hasDefault = Object.hasOwn(module, "default");
  const hasConfig = Object.hasOwn(module, "config");

  if (hasDefault && hasConfig) {
    throw new TypeError(
      'config module must not export both "default" and "config"',
    );
  }
  if (!hasDefault && !hasConfig) {
    throw new TypeError(
      'config module must export exactly one of "default" or "config"',
    );
  }

  const selected = hasDefault ? "default" : "config";
  const extra = exports.find((name) => name !== selected);
  if (extra !== undefined) {
    throw new TypeError(
      `config module may only export "${selected}"; found extra export "${extra}"`,
    );
  }
  return module[selected];
}

/**
 * Loads exactly one local TypeScript configuration module.
 *
 * The module must export either `default` or named `config` (never both and no
 * additional exports). The exported value is data, not a factory function.
 */
export async function loadConfig(
  source: LoadConfigSource = "./oxian.config.ts",
): Promise<OxianConfig> {
  const url = configModuleUrl(source);
  const module = await import(url.href) as Readonly<Record<string, unknown>>;
  const exported = selectModuleExport(module);
  const baseDirectory = dirname(fromFileUrl(url));
  return normalizeConfig(exported, { baseDirectory });
}
