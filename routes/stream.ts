import type { Context, Data } from "../src/core/types.ts";

export async function GET(_data: Data, { response }: Context) {
  response.headers({ "content-type": "text/plain; charset=utf-8" });
  response.stream("hello\n");
  await new Promise((r) => setTimeout(r, 2000));
  response.stream("world\n");
  return;
}
