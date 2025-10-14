import type { Context, Data } from "oxian-js/types.ts";

export default function (data: Data, context: Context) {
  const { params } = data || {};
  context.response.headers({ "x-request-id": context.requestId });
  return { params: { ...(params || {}), foo: "bar" } };
}
