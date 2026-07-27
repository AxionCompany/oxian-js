import type { ApplicationConfig } from "../config/types.ts";
import { createFileRouter } from "../router/file_router.ts";
import type { CreateFileRouterOptions, FileRouter } from "../router/types.ts";
import { createApplication } from "./application.ts";
import { loadApplicationFactory } from "./factory.ts";
import type { Application } from "./types.ts";

export type ConfiguredApplication = Readonly<{
  router: FileRouter<unknown>;
  application: Application<unknown>;
}>;

export type CreateConfiguredApplicationOptions = Readonly<{
  config: ApplicationConfig;
  signal: AbortSignal;
  createRouter?: (
    options: CreateFileRouterOptions,
  ) => Promise<FileRouter<unknown>>;
}>;

/**
 * Composes one normalized application declaration into its immutable router
 * and Application.
 *
 * This is the single runtime boundary for the default application and explicit
 * factory paths. If cancellation races with asynchronous route/factory setup,
 * a constructed Application is disposed before the abort is rethrown.
 */
export async function createConfiguredApplication(
  options: CreateConfiguredApplicationOptions,
): Promise<ConfiguredApplication> {
  if (
    options === null ||
    typeof options !== "object" ||
    !(options.signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      "configured application options require an AbortSignal",
    );
  }
  const createRouter = options.createRouter ??
    ((input: CreateFileRouterOptions) => createFileRouter<unknown>(input));
  if (typeof createRouter !== "function") {
    throw new TypeError(
      "configured application createRouter must be a function",
    );
  }

  options.signal.throwIfAborted();
  const router = await createRouter({
    root: options.config.routesRoot,
  });
  options.signal.throwIfAborted();

  let application: Application<unknown> | undefined;
  try {
    const basePath = options.config.basePath;
    if (options.config.factory === undefined) {
      application = await createApplication<unknown>({ router, basePath });
    } else {
      const factory = await loadApplicationFactory(
        options.config.factory,
      );
      options.signal.throwIfAborted();
      application = await factory({
        router,
        basePath,
        signal: options.signal,
      });
    }
    options.signal.throwIfAborted();
    return Object.freeze({ router, application });
  } catch (error) {
    await application?.dispose(
      options.signal.aborted
        ? options.signal.reason
        : "application_configuration_failed",
    ).catch(() => undefined);
    throw error;
  }
}
