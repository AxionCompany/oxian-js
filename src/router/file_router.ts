import { resolve, toFileUrl } from "@std/path";
import {
  type CatchallRouteSegment,
  type CompiledMiddleware,
  type CompiledRoute,
  type CreateFileRouterOptions,
  type FileRouter,
  HTTP_METHODS,
  type HttpMethod,
  type ParamRouteSegment,
  type RouteHandler,
  type RouteMatch,
  type RouteMiddleware,
  type RouteParamValue,
  type RouteSegment,
  type StaticRouteSegment,
} from "./types.ts";

const MODULE_EXTENSIONS = Object.freeze(
  [
    ".ts",
    ".js",
    ".mts",
    ".mjs",
  ] as const,
);

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PARAMETER_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

type ModuleNamespace = Readonly<Record<string, unknown>>;

type DiscoveredModule = Readonly<{
  absoluteUrl: string;
  directoryParts: readonly string[];
  extension: string;
  kind: "middleware" | "route";
  logicalRelativePath: string;
  relativePath: string;
  routeParts?: readonly string[];
}>;

type InternalRoute<State> = Readonly<{
  middlewares: readonly CompiledMiddleware<State>[];
  route: CompiledRoute<State>;
}>;

type MutableTrieNode<State> = {
  catchallChild?: MutableTrieNode<State>;
  entry?: InternalRoute<State>;
  paramChild?: MutableTrieNode<State>;
  staticChildren: Map<string, MutableTrieNode<State>>;
};

type FrozenTrieChild<State> = readonly [
  segment: string,
  node: FrozenTrieNode<State>,
];

type FrozenTrieNode<State> = Readonly<{
  catchallChild?: FrozenTrieNode<State>;
  entry?: InternalRoute<State>;
  paramChild?: FrozenTrieNode<State>;
  staticChildren: readonly FrozenTrieChild<State>[];
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ensureTrailingSlash(url: URL): URL {
  const result = new URL(url.href);
  if (!result.pathname.endsWith("/")) result.pathname += "/";
  return result;
}

function resolveRoot(root: string | URL): URL {
  let url: URL;
  if (root instanceof URL) {
    url = new URL(root.href);
  } else if (
    !/^[a-zA-Z]:[\\/]/.test(root) &&
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(root)
  ) {
    url = new URL(root);
  } else {
    url = toFileUrl(resolve(root));
  }

  if (url.protocol !== "file:") {
    throw new TypeError(
      `File router root must use the file: protocol; received ${url.protocol}`,
    );
  }

  return ensureTrailingSlash(url);
}

function extensionOf(name: string): string | null {
  for (const extension of MODULE_EXTENSIONS) {
    if (name.endsWith(extension)) return extension;
  }
  return null;
}

function stripExtension(name: string, extension: string): string {
  return name.slice(0, -extension.length);
}

function routePartsForFile(
  directoryParts: readonly string[],
  basename: string,
): readonly string[] {
  return basename === "index"
    ? Object.freeze([...directoryParts])
    : Object.freeze([...directoryParts, basename]);
}

async function discoverModules(
  root: URL,
): Promise<readonly DiscoveredModule[]> {
  const discovered: DiscoveredModule[] = [];
  const logicalPaths = new Map<string, DiscoveredModule>();

  async function walk(
    directoryUrl: URL,
    directoryParts: string[],
  ): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(directoryUrl)) entries.push(entry);
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      if (entry.isSymlink) continue;

      const entryUrl = new URL(
        encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""),
        directoryUrl,
      );
      if (entry.isDirectory) {
        await walk(entryUrl, [...directoryParts, entry.name]);
        continue;
      }
      if (!entry.isFile) continue;

      const extension = extensionOf(entry.name);
      if (extension === null) continue;

      const basename = stripExtension(entry.name, extension);
      if (basename.startsWith("_") && basename !== "_middleware") continue;

      const relativePath = [...directoryParts, entry.name].join("/");
      const logicalRelativePath = [
        ...directoryParts,
        basename,
      ].join("/");
      const kind = basename === "_middleware" ? "middleware" : "route";
      const module: DiscoveredModule = Object.freeze({
        absoluteUrl: entryUrl.href,
        directoryParts: Object.freeze([...directoryParts]),
        extension,
        kind,
        logicalRelativePath,
        relativePath,
        routeParts: kind === "route"
          ? routePartsForFile(directoryParts, basename)
          : undefined,
      });

      const collision = logicalPaths.get(logicalRelativePath);
      if (collision) {
        throw new Error(
          `Route module extension collision: ${collision.relativePath} and ${relativePath}`,
        );
      }
      logicalPaths.set(logicalRelativePath, module);
      discovered.push(module);
    }
  }

  await walk(root, []);
  return Object.freeze(discovered);
}

function parseRouteSegment(token: string, source: string): RouteSegment {
  const catchall = /^\[\.\.\.([^\[\]./]+)\]$/.exec(token);
  if (catchall) {
    validateParameterName(catchall[1], source);
    return Object.freeze(
      {
        type: "catchall",
        name: catchall[1],
      } satisfies CatchallRouteSegment,
    );
  }

  const param = /^\[([^\[\]./]+)\]$/.exec(token);
  if (param) {
    validateParameterName(param[1], source);
    return Object.freeze(
      {
        type: "param",
        name: param[1],
      } satisfies ParamRouteSegment,
    );
  }

  if (token.includes("[") || token.includes("]")) {
    throw new Error(
      `Invalid route segment "${token}" in ${source}`,
    );
  }
  if (token.length === 0) {
    throw new Error(`Empty route segment in ${source}`);
  }

  return Object.freeze(
    {
      type: "static",
      value: token,
    } satisfies StaticRouteSegment,
  );
}

function validateParameterName(name: string, source: string): void {
  if (!PARAMETER_NAME.test(name) || RESERVED_PARAMETER_NAMES.has(name)) {
    throw new Error(
      `Invalid route parameter "${name}" in ${source}; parameter names must be safe JavaScript identifiers`,
    );
  }
}

function compileSegments(
  routeParts: readonly string[],
  source: string,
): readonly RouteSegment[] {
  const segments = routeParts.map((part) => parseRouteSegment(part, source));
  const parameterNames = new Set<string>();

  for (const [index, segment] of segments.entries()) {
    if (segment.type === "static") continue;
    if (parameterNames.has(segment.name)) {
      throw new Error(
        `Duplicate route parameter "${segment.name}" in ${source}`,
      );
    }
    parameterNames.add(segment.name);

    if (segment.type === "catchall" && index !== segments.length - 1) {
      throw new Error(
        `Catchall segment "[...${segment.name}]" must be final in ${source}`,
      );
    }
  }

  return Object.freeze(segments);
}

function patternFor(segments: readonly RouteSegment[]): string {
  if (segments.length === 0) return "/";
  return "/" + segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return `:${segment.name}`;
    return `*${segment.name}`;
  }).join("/");
}

function structureFor(segments: readonly RouteSegment[]): string {
  if (segments.length === 0) return "/";
  return "/" + segments.map((segment) => {
    if (segment.type === "static") return `s:${segment.value}`;
    if (segment.type === "param") return "p:";
    return "c:";
  }).join("/");
}

function canonicalKeyFor(segments: readonly RouteSegment[]): string {
  return JSON.stringify(segments.map((segment) => {
    if (segment.type === "static") return ["static", segment.value];
    if (segment.type === "param") return ["param", segment.name];
    return ["catchall", segment.name];
  }));
}

function isUnsupportedUppercaseExport(name: string): boolean {
  return /^[A-Z][A-Z\d_]*$/.test(name);
}

function compileMethods<State>(
  namespace: ModuleNamespace,
  source: string,
): Readonly<Partial<Record<HttpMethod, RouteHandler<State>>>> {
  const methods: Partial<Record<HttpMethod, RouteHandler<State>>> = {};

  if (Object.hasOwn(namespace, "default") || Object.hasOwn(namespace, "all")) {
    throw new Error(
      `Route module ${source} must use named HTTP method exports; default and all handlers are not supported`,
    );
  }

  for (const method of HTTP_METHODS) {
    if (!Object.hasOwn(namespace, method)) continue;
    const candidate = namespace[method];
    if (typeof candidate !== "function") {
      throw new TypeError(
        `Route export ${method} must be a function in ${source}`,
      );
    }
    methods[method] = candidate as RouteHandler<State>;
  }

  for (const name of Object.keys(namespace)) {
    if (HTTP_METHOD_SET.has(name)) continue;
    if (isUnsupportedUppercaseExport(name)) {
      throw new Error(
        `Unsupported uppercase HTTP method export ${name} in ${source}`,
      );
    }
  }

  if (Object.keys(methods).length === 0) {
    throw new Error(
      `Route module ${source} must export at least one named HTTP method`,
    );
  }

  return Object.freeze(methods);
}

function compileMiddleware<State>(
  namespace: ModuleNamespace,
  source: string,
): CompiledMiddleware<State> {
  const middleware = namespace.middleware;
  if (typeof middleware !== "function") {
    throw new TypeError(
      `Middleware module ${source} must export a named middleware function`,
    );
  }
  return Object.freeze({
    fileUrl: source,
    middleware: middleware as RouteMiddleware<State>,
  });
}

function createMutableTrieNode<State>(): MutableTrieNode<State> {
  return { staticChildren: new Map() };
}

function insertRoute<State>(
  root: MutableTrieNode<State>,
  internalRoute: InternalRoute<State>,
): void {
  let node = root;

  for (const segment of internalRoute.route.segments) {
    if (segment.type === "static") {
      let child = node.staticChildren.get(segment.value);
      if (!child) {
        child = createMutableTrieNode<State>();
        node.staticChildren.set(segment.value, child);
      }
      node = child;
      continue;
    }

    if (segment.type === "param") {
      if (!node.paramChild) {
        node.paramChild = createMutableTrieNode<State>();
      }
      node = node.paramChild;
      continue;
    }

    if (!node.catchallChild) {
      node.catchallChild = createMutableTrieNode<State>();
    }
    node = node.catchallChild;
  }

  node.entry = internalRoute;
}

function freezeTrie<State>(
  mutable: MutableTrieNode<State>,
): FrozenTrieNode<State> {
  const staticChildren = [...mutable.staticChildren.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([segment, node]) =>
      Object.freeze(
        [
          segment,
          freezeTrie(node),
        ] as const,
      )
    );

  return Object.freeze({
    staticChildren: Object.freeze(staticChildren),
    entry: mutable.entry,
    paramChild: mutable.paramChild ? freezeTrie(mutable.paramChild) : undefined,
    catchallChild: mutable.catchallChild
      ? freezeTrie(mutable.catchallChild)
      : undefined,
  });
}

function decodePathname(pathname: string): readonly string[] {
  const queryIndex = pathname.indexOf("?");
  const hashIndex = pathname.indexOf("#");
  let end = pathname.length;
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  if (hashIndex >= 0) end = Math.min(end, hashIndex);

  try {
    return Object.freeze(
      pathname.slice(0, end).split("/").filter(Boolean).map(decodeURIComponent),
    );
  } catch (error) {
    if (error instanceof URIError) {
      throw new URIError("Malformed URL path");
    }
    throw error;
  }
}

function findStaticChild<State>(
  node: FrozenTrieNode<State>,
  segment: string,
): FrozenTrieNode<State> | undefined {
  for (const [candidate, child] of node.staticChildren) {
    if (candidate === segment) return child;
  }
  return undefined;
}

function findMatch<State>(
  node: FrozenTrieNode<State>,
  pathSegments: readonly string[],
  index: number,
  captures: readonly RouteParamValue[],
):
  | Readonly<{
    captures: readonly RouteParamValue[];
    entry: InternalRoute<State>;
  }>
  | null {
  if (index === pathSegments.length) {
    return node.entry ? { captures, entry: node.entry } : null;
  }

  const value = pathSegments[index];
  const staticChild = findStaticChild(node, value);
  if (staticChild) {
    const match = findMatch(staticChild, pathSegments, index + 1, captures);
    if (match) return match;
  }

  if (node.paramChild) {
    const match = findMatch(
      node.paramChild,
      pathSegments,
      index + 1,
      [...captures, value],
    );
    if (match) return match;
  }

  if (node.catchallChild) {
    const values = Object.freeze(pathSegments.slice(index));
    const match = findMatch(
      node.catchallChild,
      pathSegments,
      pathSegments.length,
      [...captures, values],
    );
    if (match) return match;
  }

  return null;
}

/**
 * Walks, imports, validates, and freezes a route tree. No filesystem or module
 * loader work occurs after this promise resolves.
 */
export async function createFileRouter<State = unknown>(
  options: CreateFileRouterOptions,
): Promise<FileRouter<State>> {
  const rootUrl = resolveRoot(options.root);
  const discovered = await discoverModules(rootUrl);
  const namespaces = new Map<string, ModuleNamespace>();

  for (const module of discovered) {
    namespaces.set(
      module.absoluteUrl,
      await import(module.absoluteUrl) as ModuleNamespace,
    );
  }

  const middlewareByDirectory = new Map<
    string,
    CompiledMiddleware<State>
  >();
  for (const module of discovered) {
    if (module.kind !== "middleware") continue;
    middlewareByDirectory.set(
      module.directoryParts.join("/"),
      compileMiddleware<State>(
        namespaces.get(module.absoluteUrl)!,
        module.absoluteUrl,
      ),
    );
  }

  const routes: InternalRoute<State>[] = [];
  const canonicalPatterns = new Map<string, string>();
  const structuralPatterns = new Map<string, string>();

  for (const module of discovered) {
    if (module.kind !== "route") continue;

    const segments = compileSegments(module.routeParts!, module.relativePath);
    const pattern = patternFor(segments);
    const canonicalKey = canonicalKeyFor(segments);
    const structure = structureFor(segments);
    const canonicalCollision = canonicalPatterns.get(canonicalKey);
    if (canonicalCollision) {
      throw new Error(
        `Duplicate canonical route ${pattern}: ${canonicalCollision} and ${module.relativePath}`,
      );
    }
    const structuralCollision = structuralPatterns.get(structure);
    if (structuralCollision) {
      throw new Error(
        `Structurally ambiguous route ${pattern}: ${structuralCollision} and ${module.relativePath}`,
      );
    }
    canonicalPatterns.set(canonicalKey, module.relativePath);
    structuralPatterns.set(structure, module.relativePath);

    const methods = compileMethods<State>(
      namespaces.get(module.absoluteUrl)!,
      module.absoluteUrl,
    );
    const route = Object.freeze(
      {
        pattern,
        fileUrl: module.absoluteUrl,
        segments,
        methods,
      } satisfies CompiledRoute<State>,
    );

    const middlewares: CompiledMiddleware<State>[] = [];
    for (let depth = 0; depth <= module.directoryParts.length; depth++) {
      const middleware = middlewareByDirectory.get(
        module.directoryParts.slice(0, depth).join("/"),
      );
      if (middleware) middlewares.push(middleware);
    }

    routes.push(Object.freeze({
      route,
      middlewares: Object.freeze(middlewares),
    }));
  }

  routes.sort((left, right) => {
    const patternOrder = compareStrings(
      left.route.pattern,
      right.route.pattern,
    );
    return patternOrder !== 0
      ? patternOrder
      : compareStrings(left.route.fileUrl, right.route.fileUrl);
  });

  const mutableTrie = createMutableTrieNode<State>();
  for (const route of routes) insertRoute(mutableTrie, route);
  const trie = freezeTrie(mutableTrie);
  const publicRoutes = Object.freeze(routes.map(({ route }) => route));

  function match(pathname: string): RouteMatch<State> | null {
    const result = findMatch(trie, decodePathname(pathname), 0, []);
    if (!result) return null;

    const params: Record<string, RouteParamValue> = {};
    let captureIndex = 0;
    for (const segment of result.entry.route.segments) {
      if (segment.type === "static") continue;
      params[segment.name] = result.captures[captureIndex++];
    }

    return Object.freeze({
      route: result.entry.route,
      params: Object.freeze(params),
      middlewares: result.entry.middlewares,
    });
  }

  return Object.freeze({
    root: rootUrl.href,
    routes: publicRoutes,
    match,
  });
}
