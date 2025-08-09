import type { Context, Data } from "../../src/core/types.ts";

export default function (data: Data, context: Context) {
  const auth = context.request.headers.get("authorization");
  if (!auth) throw { message: "Unauthorized", statusCode: 401, statusText: "Unauthorized" };
  return { data: { ...data, scope: "users" } };
} 