/**
 * @fileoverview `oxian prepare` command — runs prepare hooks from config.
 * @module cli/commands/prepare
 */

import type { OxianConfig } from "../../config/index.ts";
import { createResolver } from "../../resolvers/index.ts";
import type { EnvDefaults } from "../config_loader.ts";

export async function runPrepare(opts: {
  source: string;
  envDefaults: EnvDefaults;
}): Promise<void> {
  const source = opts.source;

  // Remote sources skip prepare
  if (
    source.startsWith("https:") || source.startsWith("http:") ||
    source.startsWith("github:")
  ) {
    return;
  }

  const rootUrl = source.startsWith("file:")
    ? new URL(source)
    : new URL(`file://${source}`);
  const matResolver = createResolver(rootUrl, opts.envDefaults);
  const candidates = [
    "oxian.config.ts",
    "oxian.config.js",
    "oxian.config.mjs",
    "oxian.config.json",
  ];
  let matConfig: unknown = undefined;
  for (const name of candidates) {
    try {
      const mod = await matResolver.import(name);
      const pick = (mod?.default ?? (mod as { config?: unknown })?.config ??
        mod) as unknown;
      matConfig = pick;
      break;
    } catch { /* try next */ }
  }
  const cfgObj = (typeof matConfig === "function")
    ? await (matConfig as (
      defaults: Partial<OxianConfig>,
    ) => Partial<OxianConfig>)({})
    : (matConfig as Partial<OxianConfig> | undefined);
  const hooks = (cfgObj as {
    prepare?: Array<
      string | { cmd: string; cwd?: string; env?: Record<string, string> }
    >;
  })?.prepare;
  if (hooks && Array.isArray(hooks) && hooks.length) {
    for (const h of hooks) {
      const c = typeof h === "string" ? h : h.cmd;
      if (!c || !c.trim()) continue;
      const cwd = typeof h === "string" ? undefined : h.cwd;
      const env = typeof h === "string" ? undefined : h.env;
      const shell = Deno.build.os === "windows"
        ? ["cmd", "/c", c]
        : ["/bin/sh", "-lc", c];
      const proc = new Deno.Command(shell[0], {
        args: shell.slice(1),
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
        cwd: cwd ?? ".",
        env: env ? { ...env } : undefined,
      });
      const out = await proc.output();
      if (!out.success) throw new Error(`[cli] prepare failed: ${c}`);
    }
  }
}
