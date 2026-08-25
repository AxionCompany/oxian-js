import type {
  HttpMethod,
  RouteContext,
  RouteMethods,
  RouteMiddleware,
} from "../router/types.ts";
import { runMiddleware } from "./middleware.ts";
import { trackResponse, withoutBody } from "./response.ts";
import {
  normalizeApplicationBasePath,
  stripApplicationBasePath,
} from "./base_path.ts";
import type {
  Application,
  ApplicationErrorContext,
  ApplicationOptions,
} from "./types.ts";

const METHOD_ORDER: readonly HttpMethod[] = Object.freeze([
  "GET",
  "HEAD",
  "QUERY",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

function allowedMethods<State>(
  methods: RouteMethods<State>,
): readonly HttpMethod[] {
  const allowed = new Set<HttpMethod>();
  for (const method of METHOD_ORDER) {
    if (typeof methods[method] === "function") allowed.add(method);
  }
  if (allowed.has("GET")) allowed.add("HEAD");
  allowed.add("OPTIONS");
  return Object.freeze(METHOD_ORDER.filter((method) => allowed.has(method)));
}

function methodNotAllowed(allow: readonly HttpMethod[]): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: allow.join(", ") },
  });
}

function defaultErrorResponse(): Response {
  return new Response("Internal Server Error", { status: 500 });
}

function malformedPathResponse(): Response {
  return new Response("Bad Request", { status: 400 });
}

function combineSignals(left: AbortSignal, right: AbortSignal): AbortSignal {
  if (left === right) return left;
  return AbortSignal.any([left, right]);
}

/**
 * Initializes one Fetch-native application instance. Route modules have
 * already been imported and validated by the file-router factory.
 */
export async function createApplication<State = undefined>(
  options: ApplicationOptions<State>,
): Promise<Application<State>> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("application options are required");
  }
  const router = options.router;
  if (
    router === null ||
    typeof router !== "object" ||
    typeof router.root !== "string" ||
    !Array.isArray(router.routes) ||
    typeof router.match !== "function"
  ) {
    throw new TypeError("application router must be a FileRouter");
  }
  const setup = options.setup;
  if (setup !== undefined && typeof setup !== "function") {
    throw new TypeError("application setup must be a function");
  }
  if (setup !== undefined && "state" in options) {
    throw new TypeError("application accepts either setup or state, not both");
  }
  if (
    options.middleware !== undefined &&
    !Array.isArray(options.middleware)
  ) {
    throw new TypeError("application middleware must be an array");
  }
  const globalMiddleware = Object.freeze([...(options.middleware ?? [])]);
  if (
    globalMiddleware.some((middleware) => typeof middleware !== "function")
  ) {
    throw new TypeError("application middleware must contain only functions");
  }
  const onError = options.onError;
  if (onError !== undefined && typeof onError !== "function") {
    throw new TypeError("application onError must be a function");
  }
  const disposeHook = options.dispose;
  if (disposeHook !== undefined && typeof disposeHook !== "function") {
    throw new TypeError("application dispose must be a function");
  }
  const basePath = normalizeApplicationBasePath(options.basePath);
  const lifecycle = new AbortController();
  let state: State;
  try {
    state = setup === undefined
      ? options.state as State
      : await setup({ signal: lifecycle.signal });
  } catch (error) {
    lifecycle.abort(error);
    throw error;
  }

  let acceptingRequests = true;
  let activeRequests = 0;
  let disposal: Promise<void> | undefined;
  const active = new Set<Promise<void>>();

  const handleError = async (
    error: unknown,
    context: ApplicationErrorContext<State>,
  ): Promise<Response> => {
    if (onError === undefined) return defaultErrorResponse();
    try {
      const response = await onError(error, context);
      return response instanceof Response ? response : defaultErrorResponse();
    } catch {
      return defaultErrorResponse();
    }
  };

  const fetch = async (request: Request): Promise<Response> => {
    if (!(request instanceof Request)) {
      throw new TypeError("application.fetch expects a Request");
    }
    if (!acceptingRequests) {
      return new Response("Service Unavailable", { status: 503 });
    }

    activeRequests++;
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    active.add(finished);
    let completionFinished = false;
    const finish = (): void => {
      if (completionFinished) return;
      completionFinished = true;
      activeRequests--;
      active.delete(finished);
      resolveFinished();
    };

    const signal = combineSignals(request.signal, lifecycle.signal);
    const baseErrorContext = {
      request,
      state,
      signal,
    } satisfies ApplicationErrorContext<State>;

    try {
      const pathname = stripApplicationBasePath(
        new URL(request.url).pathname,
        basePath,
      );
      const match = pathname === null ? null : router.match(pathname);
      if (match === null) {
        let response = new Response("Not Found", { status: 404 });
        if (request.method.toUpperCase() === "HEAD") {
          response = await withoutBody(response);
        }
        return trackResponse(response, signal, { finish });
      }

      const context = Object.freeze({
        params: match.params,
        route: match.route,
        state,
        signal,
      }) satisfies RouteContext<State>;
      const errorContext = {
        ...baseErrorContext,
        route: match.route,
        params: match.params,
      } satisfies ApplicationErrorContext<State>;
      const method = request.method.toUpperCase();
      const allow = allowedMethods(match.route.methods);

      let response: Response;
      if (method === "OPTIONS" && match.route.methods.OPTIONS === undefined) {
        response = new Response(null, {
          status: 204,
          headers: { allow: allow.join(", ") },
        });
      } else {
        const selected = method === "HEAD" &&
            match.route.methods.HEAD === undefined
          ? match.route.methods.GET
          : match.route.methods[method as HttpMethod];
        if (selected === undefined) {
          response = methodNotAllowed(allow);
        } else {
          const middleware: readonly RouteMiddleware<State>[] = Object.freeze([
            ...globalMiddleware,
            ...match.middlewares.map((entry) => entry.middleware),
          ]);
          try {
            response = await runMiddleware(
              request,
              context,
              middleware,
              selected,
            );
          } catch (error) {
            response = await handleError(error, errorContext);
          }
        }
      }

      if (method === "HEAD") response = await withoutBody(response);
      return trackResponse(response, signal, { finish });
    } catch (error) {
      let response = error instanceof URIError
        ? malformedPathResponse()
        : await handleError(error, baseErrorContext);
      if (request.method.toUpperCase() === "HEAD") {
        response = await withoutBody(response);
      }
      return trackResponse(response, signal, { finish });
    }
  };

  const dispose = (reason: unknown = "application_disposed"): Promise<void> => {
    if (disposal !== undefined) return disposal;
    acceptingRequests = false;
    // Publish the stable promise before abort dispatch. Abort listeners run
    // synchronously and are allowed to re-enter dispose().
    disposal = Promise.resolve().then(async () => {
      await Promise.allSettled([...active]);
      await disposeHook?.(state, {
        reason,
        signal: lifecycle.signal,
      });
    });
    lifecycle.abort(reason);
    return disposal;
  };

  return Object.freeze({
    router,
    basePath,
    state,
    fetch,
    dispose,
    snapshot: () =>
      Object.freeze({
        acceptingRequests,
        activeRequests,
      }),
  });
}
