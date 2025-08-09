import type { Context, Data } from "../src/core/types.ts";


export async function GET(_data: Data, { response }: Context) {
  const write = response.stream({ headers: { "content-type": "text/plain; charset=utf-8" } });
  write("hello");
  await new Promise((r) => setTimeout(r, 500));
  write(" world");
  write("");
} 