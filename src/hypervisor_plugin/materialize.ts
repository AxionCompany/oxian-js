/**
 * @fileoverview Direct materialize and prepare operations for the plugin.
 *
 * These functions call the extracted command modules directly instead of
 * spawning CLI subprocesses, eliminating the recursive cli.ts invocation.
 *
 * @module hypervisor_plugin/materialize
 */

import { runMaterialize } from "../cli/commands/materialize.ts";
import { runPrepare } from "../cli/commands/prepare.ts";
import type { EnvDefaults } from "../cli/config_loader.ts";

/**
 * Run the materialize step directly (no subprocess).
 */
export async function materializeDirect(opts: {
  source: string;
  dir: string;
  refresh: boolean;
  envDefaults: EnvDefaults;
}): Promise<void> {
  await runMaterialize({
    source: opts.source,
    materializeDir: opts.dir,
    materializeRefresh: opts.refresh,
    envDefaults: opts.envDefaults,
  });
}

/**
 * Run the prepare step directly (no subprocess).
 */
export async function prepareDirect(opts: {
  source: string;
  envDefaults: EnvDefaults;
}): Promise<void> {
  await runPrepare({
    source: opts.source,
    envDefaults: opts.envDefaults,
  });
}
