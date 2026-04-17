import type { Context, Data } from "oxian-js/types.ts";

export function GET({ path }: Data, _context: Context) {
  return { path };
}
