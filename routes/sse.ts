import type { Context, Data } from "oxian-js/types.ts";

export async function GET(_data: Data, { response, oxian, dependencies }: Context) {
  const sse = response.sse({ retry: 1000, keepOpen: true });
  let i = 0;
  console.log(dependencies);
  const interval = setInterval(() => {
    i++;
    sse.send({ tick: i }, { event: "ticks" });
    sse.send({dependencies: dependencies}, { event: "dependencies" });
    if (i >= 3) {
      clearInterval(interval);
      sse.close();
    }
  }, 500);
} 