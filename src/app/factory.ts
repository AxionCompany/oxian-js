import { resolve, toFileUrl } from "@std/path";
import { normalizeApplicationBasePath } from "./base_path.ts";
import type {
  Application,
  ApplicationFactory,
  ApplicationFactoryContext,
  LoadApplicationFactorySource,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

const APPLICATION_KEYS = Object.freeze([
  "router",
  "basePath",
  "state",
  "fetch",
  "dispose",
  "snapshot",
]);

function applicationFactoryModuleUrl(
  source: LoadApplicationFactorySource,
): URL {
  let url: URL;
  if (source instanceof URL) {
    url = new URL(source.href);
  } else if (typeof source === "string" && source.length > 0) {
    if (
      !/^[a-zA-Z]:[\\/]/.test(source) &&
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)
    ) {
      try {
        url = new URL(source);
      } catch {
        throw new TypeError(
          "application factory source must be a local TypeScript module",
        );
      }
    } else {
      url = toFileUrl(resolve(source));
    }
  } else {
    throw new TypeError(
      "application factory source must be a local TypeScript module",
    );
  }

  if (
    url.protocol !== "file:" ||
    url.hostname !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(".ts")
  ) {
    throw new TypeError(
      "application factory source must be a local .ts module without a query or fragment",
    );
  }
  return url;
}

function expectFactoryContext<State>(
  value: ApplicationFactoryContext<State>,
): ApplicationFactoryContext<State> {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.router?.match !== "function" ||
    !(value.signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      "application factory context must contain a router and AbortSignal",
    );
  }
  return Object.freeze({
    router: value.router,
    basePath: normalizeApplicationBasePath(
      value.basePath,
      "application factory context.basePath",
    ),
    signal: value.signal,
  });
}

function expectApplication<State>(
  value: unknown,
  context: ApplicationFactoryContext<State>,
): Application<State> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(
      "application factory must return an Application object",
    );
  }
  const record = value as UnknownRecord;
  const ownKeys = Reflect.ownKeys(record);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !APPLICATION_KEYS.includes(key)) {
      throw new TypeError(
        `application factory returned an unexpected property "${String(key)}"`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(
        `application factory result.${key} must be an enumerable data property`,
      );
    }
  }
  for (const key of APPLICATION_KEYS) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(
        `application factory result is missing "${key}"`,
      );
    }
  }
  if (
    typeof record.fetch !== "function" ||
    typeof record.dispose !== "function" ||
    typeof record.snapshot !== "function"
  ) {
    throw new TypeError(
      "application factory result must provide fetch, dispose, and snapshot functions",
    );
  }
  if (record.router !== context.router) {
    throw new TypeError(
      "application factory must return an Application using the provided router",
    );
  }
  if (record.basePath !== context.basePath) {
    throw new TypeError(
      "application factory must return an Application using the provided basePath",
    );
  }
  if (!Object.isFrozen(record)) {
    throw new TypeError("application factory must return a frozen Application");
  }
  return value as Application<State>;
}

async function disposeRejectedApplication(value: unknown): Promise<void> {
  try {
    if (value === null || typeof value !== "object") return;
    const descriptor = Object.getOwnPropertyDescriptor(value, "dispose");
    if (typeof descriptor?.value !== "function") return;
    await descriptor.value.call(value, "application_factory_rejected");
  } catch {
    // Preserve the boundary validation error. A rejected Application never
    // becomes runtime-owned, so cleanup is necessarily best effort.
  }
}

/**
 * Defines a functional application entrypoint and enforces its boundary.
 *
 * The user callback always receives a newly frozen context. Its result must be
 * a frozen Application using the exact router and canonical basePath supplied
 * by the runtime.
 */
export function defineApplicationFactory<State = unknown>(
  factory: ApplicationFactory<State>,
): ApplicationFactory<State> {
  if (typeof factory !== "function") {
    throw new TypeError("application factory must be a function");
  }
  const defined: ApplicationFactory<State> = async (input) => {
    const context = expectFactoryContext(input);
    const result = await factory(context);
    try {
      return expectApplication(result, context);
    } catch (error) {
      await disposeRejectedApplication(result);
      throw error;
    }
  };
  return Object.freeze(defined);
}

/**
 * Loads one explicit local TypeScript application factory module.
 *
 * The module must have exactly one export: its default factory function.
 */
export async function loadApplicationFactory<State = unknown>(
  source: LoadApplicationFactorySource,
): Promise<ApplicationFactory<State>> {
  const url = applicationFactoryModuleUrl(source);
  const module = await import(url.href) as Readonly<Record<string, unknown>>;
  const exports = Object.keys(module).sort();
  if (!Object.hasOwn(module, "default")) {
    throw new TypeError(
      "application factory module must export exactly one default factory",
    );
  }
  const extra = exports.find((name) => name !== "default");
  if (extra !== undefined) {
    throw new TypeError(
      `application factory module may only export "default"; found extra export "${extra}"`,
    );
  }
  return defineApplicationFactory(
    module.default as ApplicationFactory<State>,
  );
}
