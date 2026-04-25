/**
 * @fileoverview Lightweight worker entry point for hypervisor-spawned processes.
 *
 * Reads pre-serialised config from the OXIAN_CONFIG env var (base64 JSON),
 * creates a resolver, and starts the server directly — no config discovery,
 * no arg parsing, no CLI overhead.
 *
 * When OXIAN_CONFIG is not set, falls back to the full CLI for backwards
 * compatibility.
 *
 * @module worker_entry
 */

import { startServer } from "./server/server.ts";
import { createResolver } from "./resolvers/index.ts";
import type { EffectiveConfig } from "./config/index.ts";

const encoded = Deno.env.get("OXIAN_CONFIG");

if (!encoded) {
  // Fallback: behave like the old cli.ts --hypervisor=false path
  const { main } = await import("./cli/index.ts");
  await main();
} else {
  const config = JSON.parse(atob(encoded)) as EffectiveConfig;

  // Recreate resolver from the config's root
  const resolver = createResolver(config.root, {
    tokenEnv: Deno.env.get("TOKEN_ENV") || "GITHUB_TOKEN",
    tokenValue: Deno.env.get("GITHUB_TOKEN"),
  });

  await startServer({ config }, resolver);
}
