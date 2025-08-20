import type { Context, Data } from "oxian-js/types.ts";

export async function beforeRun(data: Data, _context: Context) {
  const before = Array.isArray(data.before) ? data.before : [];
  before.push("a");
  return { data: { ...data, before } };
}

export async function afterRun(_resultOrErr: unknown, { response }: Context) {
  response.headers({ "x-after": "root,a" });
} 