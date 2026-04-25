/**
 * @fileoverview `oxian materialize` command — downloads and extracts remote source locally.
 * @module cli/commands/materialize
 */

import { createResolver } from "../../resolvers/index.ts";
import type { EnvDefaults } from "../config_loader.ts";

export async function runMaterialize(opts: {
  source: string;
  materializeDir: string;
  materializeRefresh: boolean;
  envDefaults: EnvDefaults;
}): Promise<void> {
  const resolverForMat = createResolver(new URL(opts.source), opts.envDefaults);
  if (!resolverForMat.materialize) {
    throw new Error("materialize not supported for this source");
  }
  const { rootDir, ref, sha, subdir } = await resolverForMat.materialize({
    dir: opts.materializeDir,
    refresh: opts.materializeRefresh,
  });
  console.log(
    JSON.stringify({
      ok: true,
      rootDir: rootDir.toString(),
      ref,
      sha,
      subdir,
    }),
  );
}
