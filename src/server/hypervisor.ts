import type { EffectiveConfig } from "../config/types.ts";

// Temporary delegator: wire to new hypervisor implementation under src/hv
export async function startHypervisor(config: EffectiveConfig, baseArgs: string[] = []) {
  const { startHypervisor: startNew } = await import("../hv/main.ts");
  await startNew(config, baseArgs);
} 