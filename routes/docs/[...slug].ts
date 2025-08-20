import type { Context, Data } from "oxian-js/types.ts";

export function GET({ slug }: Data, { dependencies }: Context) {
  return { slug };
} 