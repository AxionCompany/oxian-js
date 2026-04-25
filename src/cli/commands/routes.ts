/**
 * @fileoverview `oxian routes` command — prints resolved route table.
 * @module cli/commands/routes
 */

import { resolveRouter } from "../../router/index.ts";
import type { EffectiveConfig } from "../../config/index.ts";
import type { Resolver } from "../../resolvers/types.ts";

export async function runRoutes(opts: {
  config: EffectiveConfig;
  resolver: Resolver;
}): Promise<void> {
  const { router } = await resolveRouter(
    { config: opts.config },
    opts.resolver,
  );
  console.log(
    "Routes:\n" + router.routes.map((r) => `  ${r.pattern}`).join("\n"),
  );
}
