import type { Context, Data } from "oxian-js/types.ts";

export function GET(_data: Data, { dependencies }: Context) {
  const { feature } = dependencies as { feature?: string };
  console.log("[feature] GET", feature);
  return { feature: feature ?? null };
}
