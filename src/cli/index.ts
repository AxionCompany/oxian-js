import { loadApplicationFactory } from "../app/factory.ts";
import { loadConfig } from "../config/config.ts";
import { createLocalRuntime } from "../local/runtime.ts";
import { loadWorkerManifest } from "../local/worker_manifest.ts";
import { createManifestWorkerRuntime } from "../local/worker_runtime.ts";
import { createFileRouter } from "../router/file_router.ts";
import {
  runCheckCommand,
  runInitCommand,
  runRoutesCommand,
  runServerCommand,
  runWorkerCommand,
} from "./commands.ts";
import { isCliInputError, parseCliArgs } from "./parser.ts";
import type { CliDependencies, CliIo, ParsedCli } from "./types.ts";

export const CLI_USAGE = `Oxian 0.20

Usage:
  oxian init [--root PATH] [--force]
  oxian dev [--config FILE] [--hostname HOST] [--port PORT]
  oxian start [--config FILE] [--hostname HOST] [--port PORT]
  oxian worker [--manifest FILE]
  oxian routes [--config FILE]
  oxian check [--config FILE]

Commands:
  init     Write a minimal oxian.config.ts and routes/index.ts
  dev      Run the local Hypervisor and Worker with dev edges
  start    Run the local Hypervisor and Worker
  worker   Attach a manifest-defined HTTP worker to a WebSocket gateway
  routes   Compile and print the immutable route table
  check    Strictly validate config, application entry, and all routes

Options:
  -h, --help  Show this help
`;

function effectiveIo(input: Partial<CliIo> | undefined): CliIo {
  return Object.freeze({
    stdout: input?.stdout ?? ((message) => console.log(message)),
    stderr: input?.stderr ?? ((message) => console.error(message)),
  });
}

async function execute(
  parsed: ParsedCli,
  context: Parameters<typeof runInitCommand>[1],
): Promise<void> {
  switch (parsed.command) {
    case "init":
      return await runInitCommand(parsed, context);
    case "routes":
      return await runRoutesCommand(parsed, context);
    case "check":
      return await runCheckCommand(parsed, context);
    case "worker":
      return await runWorkerCommand(parsed, context);
    case "start":
    case "dev":
      return await runServerCommand(parsed, context);
  }
}

/**
 * Executes one v0.20 CLI invocation and returns a process exit code.
 *
 * The library never calls `Deno.exit()` and never installs signal handlers.
 * An executable entrypoint may supply `waitForLifecycle` to own signal policy.
 */
export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const io = effectiveIo(dependencies.io);
  let parsed: ParsedCli;
  try {
    parsed = parseCliArgs(args);
  } catch (error) {
    if (!isCliInputError(error)) throw error;
    io.stderr(`error: ${error.message}\n\n${CLI_USAGE}`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(CLI_USAGE);
    return 0;
  }

  try {
    const context = Object.freeze({
      cwd: dependencies.cwd?.() ?? Deno.cwd(),
      io,
      dependencies: Object.freeze({
        loadConfig: dependencies.loadConfig ?? loadConfig,
        createRouter: dependencies.createRouter ??
          ((options) => createFileRouter<unknown>(options)),
        loadApplicationFactory: dependencies.loadApplicationFactory ??
          loadApplicationFactory,
        createLocalRuntime: dependencies.createLocalRuntime ??
          createLocalRuntime,
        loadWorkerManifest: dependencies.loadWorkerManifest ??
          loadWorkerManifest,
        createManifestWorkerRuntime: dependencies.createManifestWorkerRuntime ??
          createManifestWorkerRuntime,
        waitForLifecycle: dependencies.waitForLifecycle ??
          ((lifecycle) => lifecycle.finished),
      }),
    });
    await execute(parsed, context);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`error: ${message}`);
    return 1;
  }
}

export * from "./parser.ts";
export type * from "./types.ts";
