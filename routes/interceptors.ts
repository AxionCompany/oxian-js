import type { Context, Data } from "oxian-js/types.ts";

export async function beforeRun(_data: Data, { oxian }: Context) {
  oxian.startedAt = performance.now();
}

export async function afterRun(
  resultOrErr: unknown,
  { requestId, oxian }: Context,
) {
  const hasStatusCode = typeof resultOrErr === "object" &&
    resultOrErr !== null &&
    "statusCode" in (resultOrErr as Record<string, unknown>);
  const ok = !(resultOrErr instanceof Error) && !hasStatusCode;
  console.log(
    JSON.stringify({
      requestId,
      ok,
      ms: Math.round(performance.now() - oxian.startedAt),
    }),
  );
}
