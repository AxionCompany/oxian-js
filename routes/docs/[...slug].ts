import type { Context, Data } from "../../src/core/types.ts";

export function GET({ slug }: Data, { dependencies }: Context) {
  return { slug };
} 