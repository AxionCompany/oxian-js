import type { Context, Data } from "oxian-js/types.ts";

export function GET(_data: Data, { dependencies }: Context) {
  return { value: (dependencies as any).db.value };
}
