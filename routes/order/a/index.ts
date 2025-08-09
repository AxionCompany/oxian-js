import type { Context, Data } from "../../../src/core/types.ts";

export function GET({ before }: Data, { dependencies }: Context) {
  return { before };
} 