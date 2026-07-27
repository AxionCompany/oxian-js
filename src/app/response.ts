type Completion = Readonly<{
  finish(): void;
}>;

function copyResponse(
  response: Response,
  body: BodyInit | null,
): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Wraps a response body without reading ahead. Completion fires only after
 * EOF, error, consumer cancellation, or application abort.
 */
export function trackResponse(
  response: Response,
  signal: AbortSignal,
  completion: Completion,
): Response {
  if (response.body === null) {
    completion.finish();
    return response;
  }

  const reader = response.body.getReader();
  let finished = false;
  let finishRequested = false;
  let cancellation: Promise<void> | undefined;
  let controller:
    | ReadableStreamDefaultController<Uint8Array>
    | undefined;

  const finishNow = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // The lock can already be released by a simultaneous terminal path.
    }
    completion.finish();
  };

  const cancelUpstream = (reason: unknown): Promise<void> => {
    cancellation ??= Promise.resolve().then(async () => {
      await reader.cancel(reason);
    });
    return cancellation;
  };

  const finish = (after?: Promise<unknown>): void => {
    if (finished || finishRequested) return;
    finishRequested = true;
    const pending = after ?? cancellation;
    if (pending === undefined) {
      finishNow();
      return;
    }
    void pending.catch(() => undefined).then(finishNow);
  };

  const onAbort = (): void => {
    const cancelled = cancelUpstream(signal.reason);
    try {
      controller?.error(signal.reason);
    } catch {
      // A simultaneous pull/cancel may already have terminated the wrapper.
    }
    finish(cancelled);
  };

  const body = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(nextController) {
      try {
        const result = await reader.read();
        if (result.done) {
          nextController.close();
          finish();
          return;
        }
        nextController.enqueue(result.value);
      } catch (error) {
        nextController.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try {
        await cancelUpstream(reason);
      } finally {
        finish(cancellation);
      }
    },
  });

  return copyResponse(response, body);
}

export async function withoutBody(response: Response): Promise<Response> {
  if (response.body !== null) {
    await response.body.cancel("response_body_not_allowed").catch(() =>
      undefined
    );
  }
  return copyResponse(response, null);
}
