import { resolve } from "@std/path";
import type { OxianConfig } from "../config/types.ts";
import type { FileRouter } from "../router/types.ts";
import type { CliDependencies, CliIo, ParsedCli } from "./types.ts";

const CONFIG_TEMPLATE = `export default {
  application: {
    routesRoot: "./routes",
    basePath: "/",
  },
  gateway: {
    workerTransport: "in-process",
    workerCapacity: 32,
    listener: {
      hostname: "127.0.0.1",
      port: 8000,
    },
  },
} as const;
`;

const ROUTE_TEMPLATE = `export function GET(): Response {
  return Response.json({ message: "Hello from Oxian" });
}
`;

type CommandContext = Readonly<{
  cwd: string;
  io: CliIo;
  dependencies: Required<
    Pick<
      CliDependencies,
      | "loadConfig"
      | "createRouter"
      | "loadApplicationFactory"
      | "createLocalRuntime"
      | "loadWorkerManifest"
      | "createManifestWorkerRuntime"
      | "waitForLifecycle"
    >
  >;
}>;

function moduleSource(
  cwd: string,
  value: string | undefined,
  fallback: string,
): string {
  const source = value ?? fallback;
  if (
    !/^[a-zA-Z]:[\\/]/.test(source) &&
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(source)
  ) {
    return source;
  }
  return resolve(cwd, source);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function runInitCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<void> {
  const root = resolve(context.cwd, parsed.root ?? ".");
  const configPath = resolve(root, "oxian.config.ts");
  const routesRoot = resolve(root, "routes");
  const routePath = resolve(routesRoot, "index.ts");
  const existing = (
    await Promise.all([
      pathExists(configPath),
      pathExists(routePath),
    ])
  )
    .map((exists, index) => exists ? [configPath, routePath][index] : undefined)
    .filter((path): path is string => path !== undefined);
  if (existing.length > 0 && parsed.force !== true) {
    throw new Error(
      `refusing to overwrite existing file${
        existing.length === 1 ? "" : "s"
      }: ${existing.join(", ")}`,
    );
  }

  await Deno.mkdir(routesRoot, { recursive: true });
  await Deno.writeTextFile(configPath, CONFIG_TEMPLATE, {
    createNew: parsed.force !== true,
  });
  await Deno.writeTextFile(routePath, ROUTE_TEMPLATE, {
    createNew: parsed.force !== true,
  });
  context.io.stdout(`initialized ${root}`);
}

async function loadApplication(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<
  Readonly<{
    config: OxianConfig;
    router: FileRouter<unknown>;
  }>
> {
  const config = await loadApplicationConfig(parsed, context);
  const router = await context.dependencies.createRouter({
    root: config.application.routesRoot,
  });
  return Object.freeze({ config, router });
}

async function loadApplicationConfig(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<OxianConfig> {
  const source = moduleSource(
    context.cwd,
    parsed.config,
    "oxian.config.ts",
  );
  return await context.dependencies.loadConfig(source);
}

function routeLine(route: FileRouter<unknown>["routes"][number]): string {
  const methods = Object.keys(route.methods).sort().join(",");
  return `${methods.padEnd(24)} ${route.pattern}`;
}

export async function runRoutesCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<void> {
  const { router } = await loadApplication(parsed, context);
  if (router.routes.length === 0) {
    context.io.stdout("no routes");
    return;
  }
  context.io.stdout(router.routes.map(routeLine).join("\n"));
}

export async function runCheckCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<void> {
  const { config, router } = await loadApplication(parsed, context);
  if (config.application.factory !== undefined) {
    await context.dependencies.loadApplicationFactory(
      config.application.factory,
    );
  }
  context.io.stdout(
    `configuration, application entry, and ${router.routes.length} route${
      router.routes.length === 1 ? "" : "s"
    } are valid`,
  );
}

export async function runServerCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<void> {
  if (parsed.command !== "start" && parsed.command !== "dev") {
    throw new TypeError("server command must be start or dev");
  }
  const source = moduleSource(
    context.cwd,
    parsed.config,
    "oxian.config.ts",
  );
  const config = await context.dependencies.loadConfig(source);
  const lifecycle = context.dependencies.createLocalRuntime({
    config,
    mode: parsed.command,
    listener: {
      ...(parsed.hostname === undefined ? {} : { hostname: parsed.hostname }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
    },
  });
  try {
    const running = await lifecycle.start();
    context.io.stdout(
      `Oxian ${parsed.command} listening at ${running.listenerUrl.href}`,
    );
    await context.dependencies.waitForLifecycle(lifecycle, {
      command: parsed.command,
    });
  } finally {
    await lifecycle.stop("cli_server_command_complete");
  }
}

export async function runWorkerCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<void> {
  const source = moduleSource(
    context.cwd,
    parsed.manifest,
    "oxian.worker.ts",
  );
  const manifest = await context.dependencies.loadWorkerManifest(source);
  const lifecycle = context.dependencies.createManifestWorkerRuntime({
    manifest,
  });
  try {
    await lifecycle.start();
    context.io.stdout(`Oxian worker ${manifest.identity.workerId} is ready`);
    await context.dependencies.waitForLifecycle(lifecycle, {
      command: "worker",
    });
  } finally {
    await lifecycle.stop("cli_worker_command_complete");
  }
}
