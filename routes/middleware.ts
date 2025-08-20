import type { Context, Data } from "oxian-js/types.ts";


export default function (data: Data, context: Context) {
  context.response.headers({ "x-request-id": context.requestId });
  return { data: { ...data, mw: "root" } };
} 