import type { Context, Data } from "oxian-js/types.ts";

export function GET({ before }: Data, { dependencies }: Context) {
  return { before };
} 