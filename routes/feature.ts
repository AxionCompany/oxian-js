import type { Context, Data } from "../src/core/types.ts";

export function GET(_data: Data, { dependencies }: Context) {
  const { feature } = dependencies as { feature?: string };
  return { feature: feature ?? null };
} 