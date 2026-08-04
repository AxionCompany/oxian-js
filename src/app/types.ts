import type {
  FileRouter,
  RouteContext,
  RouteMiddleware,
} from "../router/types.ts";

export type ApplicationSetupContext = Readonly<{
  signal: AbortSignal;
}>;

export type ApplicationDisposeContext = Readonly<{
  reason: unknown;
  signal: AbortSignal;
}>;

export type ApplicationErrorContext<State> = Readonly<{
  request: Request;
  route?: RouteContext<State>["route"];
  params?: RouteContext<State>["params"];
  state: State;
  signal: AbortSignal;
}>;

type ApplicationCommonOptions<State> = Readonly<{
  router: FileRouter<State>;
  /**
   * Canonical mount path. `/` mounts at the origin root; `/api` strips exactly
   * that segment boundary before route matching.
   */
  basePath?: string;
  middleware?: readonly RouteMiddleware<State>[];
  onError?: (
    error: unknown,
    context: ApplicationErrorContext<State>,
  ) => Response | Promise<Response>;
  dispose?: (
    state: State,
    context: ApplicationDisposeContext,
  ) => void | Promise<void>;
}>;

type ApplicationStateOptions<State> =
  | Readonly<{
    state: State;
    setup?: never;
  }>
  | Readonly<{
    setup: (
      context: ApplicationSetupContext,
    ) => State | Promise<State>;
    state?: never;
  }>
  | (
    undefined extends State ? Readonly<{
        state?: never;
        setup?: never;
      }>
      : never
  );

/**
 * Stateful applications must provide exactly one state source. Omitting both
 * is allowed only when `undefined` is assignable to State, preserving ergonomic
 * stateless applications without manufacturing an unsound typed state.
 */
export type ApplicationOptions<State> =
  & ApplicationCommonOptions<State>
  & ApplicationStateOptions<State>;

export type ApplicationSnapshot = Readonly<{
  acceptingRequests: boolean;
  activeRequests: number;
}>;

export type Application<State> = Readonly<{
  readonly router: FileRouter<State>;
  readonly basePath: string;
  readonly state: State;
  fetch(request: Request): Promise<Response>;
  dispose(reason?: unknown): Promise<void>;
  snapshot(): ApplicationSnapshot;
}>;

export type ApplicationFactoryContext<State = unknown> = Readonly<{
  router: FileRouter<State>;
  basePath: string;
  signal: AbortSignal;
}>;

export type ApplicationFactory<State = unknown> = (
  context: ApplicationFactoryContext<State>,
) => Application<State> | Promise<Application<State>>;

export type LoadApplicationFactorySource = string | URL;

export type ServerSentEventOptions = Readonly<{
  event?: string;
  id?: string;
  retry?: number;
}>;

export type ServerSentEventsOptions = Readonly<{
  signal?: AbortSignal;
  status?: number;
  headers?: HeadersInit;
  retry?: number;
  maxEventBytes?: number;
  bufferBytes?: number;
}>;

export type ServerSentEvents = Readonly<{
  response: Response;
  send(data: unknown, options?: ServerSentEventOptions): Promise<void>;
  comment(text: string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  readonly closed: Promise<void>;
}>;
