import type { Context, Data } from "oxian-js/types.ts";

export async function GET(_data: Data, { response, oxian }: Context) {
  const sse = response.sse({ retry: 1000, keepOpen: true });
  let i = 0;
  const interval = setInterval(() => {
    i++;
    sse.send({ tick: i }, { event: "tick" });
    if (i >= 3) {
      clearInterval(interval);
      sse.close();
    }
  }, 500);
} 