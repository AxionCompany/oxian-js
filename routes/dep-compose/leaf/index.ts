import type { Context, Data } from "../../../src/core/types.ts";

export function GET(_data: Data, { dependencies }: Context) {
  return { value: (dependencies as any).db.value };
} 