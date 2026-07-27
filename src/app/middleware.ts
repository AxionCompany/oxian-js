import type {
  RouteContext,
  RouteHandler,
  RouteMiddleware,
} from "../router/types.ts";

function expectResponse(value: unknown): Response {
  if (!(value instanceof Response)) {
    throw new TypeError("route handlers and middleware must return a Response");
  }
  return value;
}

/**
 * Composes one immutable onion chain. Each middleware may invoke `next`
 * exactly once. An ignored `next()` is still joined before the middleware
 * result settles, so detached downstream handlers cannot escape lifecycle
 * accounting.
 */
export function runMiddleware<State>(
  request: Request,
  context: RouteContext<State>,
  middleware: readonly RouteMiddleware<State>[],
  handler: RouteHandler<State>,
): Promise<Response> {
  let entered = -1;

  const dispatch = async (index: number): Promise<Response> => {
    if (index <= entered) {
      throw new TypeError("middleware next() may only be called once");
    }
    entered = index;
    const current = middleware[index];
    if (current === undefined) {
      return expectResponse(await handler(request, context));
    }

    let nextPromise: Promise<Response> | undefined;
    let scopeOpen = true;
    const next = (): Promise<Response> => {
      if (!scopeOpen) {
        throw new TypeError(
          "middleware next() cannot be called after middleware settles",
        );
      }
      if (nextPromise !== undefined) {
        throw new TypeError("middleware next() may only be called once");
      }
      nextPromise = dispatch(index + 1);
      return nextPromise;
    };

    let result: Response;
    try {
      result = await current(request, context, next);
    } finally {
      scopeOpen = false;
    }
    if (nextPromise !== undefined) {
      // Join even when middleware called next without awaiting or returning it.
      // A middleware that deliberately caught a downstream error is allowed to
      // replace it with its own Response.
      await nextPromise.catch(() => undefined);
    }
    return expectResponse(result);
  };

  return dispatch(0);
}
