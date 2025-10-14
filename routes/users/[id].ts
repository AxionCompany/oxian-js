import type { Context, Data } from "oxian-js/types.ts";

export function GET({ id, mw }: Data, { dependencies }: Context) {
  const { db } = dependencies as {
    db: { users: Map<string, { id: string; name: string }> };
  };
  const user = db.users.get(String(id));
  if (!user) {
    throw { message: "Not found", statusCode: 404, statusText: "Not Found" };
  }
  return { ...user, mw };
}
