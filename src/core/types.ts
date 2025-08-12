export type Data = Record<string, unknown>;

export type ResponseController = {
  send: (body: unknown, init?: Partial<{ status: number; headers: Record<string, string>; statusText: string }>) => void;
  stream: (init?: Partial<{ status: number; headers: Record<string, string>; statusText: string }>) => ((chunk: Uint8Array | string) => void) & { close?: () => void; done?: Promise<void> };
  sse: (init?: Partial<{ status: number; headers: Record<string, string>; retry?: number }>) => {
    send: (data: unknown, opts?: { event?: string; id?: string; retry?: number }) => void;
    comment: (text: string) => void;
    close: () => void;
    done: Promise<void>;
  };
  status: (code: number) => void;
  headers: (headers: Record<string, string>) => void;
  statusText: (text: string) => void;
};

export type Context = {
  requestId: string;
  request: {
    method: string;
    url: string;
    headers: Headers;
    pathParams: Record<string, string>;
    queryParams: URLSearchParams;
    query: Record<string, string | string[]>;
    body: unknown;
    raw: Request;
  };
  dependencies: Record<string, unknown>;
  response: ResponseController;
  oxian: { route: string; startedAt: number };
};

export type Handler = (data: Data, context: Context) => Promise<unknown | void> | unknown | void;
export type MiddlewareResult = { data?: Data; context?: Partial<Context> } | void | Promise<{ data?: Data; context?: Partial<Context> } | void>;
export type Middleware = (data: Data, context: Context) => MiddlewareResult;

export type Interceptors = {
  beforeRun?: (data: Data, context: Context) => MiddlewareResult;
  afterRun?: (resultOrError: unknown, context: Context) => unknown | void | Promise<unknown | void>;
};

export type LoaderMediaType = "ts" | "js" | "tsx" | "jsx" | "json";

export type Loader = {
  scheme: "local" | "github" | "http" | "https" | "file";
  canHandle: (url: URL) => boolean;
  load: (url: URL) => Promise<{ content: string; mediaType: LoaderMediaType }>;
  listDir?: (url: URL) => Promise<string[]>;
  stat?: (url: URL) => Promise<{ isFile: boolean; mtime?: number }>;
  cacheKey?: (url: URL) => string;
};

export class OxianHttpError extends Error {
  code?: string;
  statusCode: number;
  statusText?: string;
  details?: unknown;
  constructor(message: string, opts?: { code?: string; statusCode?: number; statusText?: string; details?: unknown }) {
    super(message);
    this.name = "OxianHttpError";
    this.code = opts?.code;
    this.statusCode = opts?.statusCode ?? 500;
    this.statusText = opts?.statusText;
    this.details = opts?.details;
  }
} 