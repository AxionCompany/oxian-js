/**
 * The deliberately small, Fetch-native Oxian router contract.
 * Route modules and middleware modules are loaded once when the router is
 * created; request matching is synchronous and performs no I/O.
 */

export const HTTP_METHODS: readonly [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "QUERY",
  "HEAD",
  "OPTIONS",
] = Object.freeze(
  [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "QUERY",
    "HEAD",
    "OPTIONS",
  ] as const,
);

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type RouteParamValue = string | readonly string[];

export type RouteParams = Readonly<
  Record<string, RouteParamValue>
>;

export type StaticRouteSegment = Readonly<{
  type: "static";
  value: string;
}>;

export type ParamRouteSegment = Readonly<{
  type: "param";
  name: string;
}>;

export type CatchallRouteSegment = Readonly<{
  type: "catchall";
  name: string;
}>;

export type RouteSegment =
  | StaticRouteSegment
  | ParamRouteSegment
  | CatchallRouteSegment;

export type RouteContext<State = unknown> = Readonly<{
  params: RouteParams;
  route: CompiledRoute<State>;
  signal: AbortSignal;
  state: State;
}>;

export type RouteHandler<State = unknown> = (
  request: Request,
  context: RouteContext<State>,
) => Response | Promise<Response>;

export type RouteMiddleware<State = unknown> = (
  request: Request,
  context: RouteContext<State>,
  next: () => Promise<Response>,
) => Response | Promise<Response>;

export type RouteMethods<State = unknown> = Readonly<
  Partial<Record<HttpMethod, RouteHandler<State>>>
>;

export type CompiledRoute<State = unknown> = Readonly<{
  /** Canonical URL pattern, such as `/users/:id` or `/assets/*path`. */
  pattern: string;
  /** Absolute module URL represented as an immutable string. */
  fileUrl: string;
  segments: readonly RouteSegment[];
  methods: RouteMethods<State>;
}>;

export type CompiledMiddleware<State = unknown> = Readonly<{
  /** Absolute module URL represented as an immutable string. */
  fileUrl: string;
  middleware: RouteMiddleware<State>;
}>;

export type RouteMatch<State = unknown> = Readonly<{
  route: CompiledRoute<State>;
  params: RouteParams;
  /** Middleware modules ordered from the routes root to the route's directory. */
  middlewares: readonly CompiledMiddleware<State>[];
}>;

export type FileRouter<State = unknown> = Readonly<{
  /** Absolute, trailing-slash-terminated URL of the routes root. */
  root: string;
  /** Immutable startup snapshot of all compiled routes. */
  routes: readonly CompiledRoute<State>[];
  /** Pure, synchronous route lookup. */
  match: (pathname: string) => RouteMatch<State> | null;
}>;

export type CreateFileRouterOptions = Readonly<{
  /** A filesystem path or a `file:` URL. */
  root: string | URL;
}>;
