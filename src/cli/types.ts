import type {
  LocalRuntime,
  ManifestWorkerRuntime,
  WorkerManifest,
} from "../local/types.ts";
import type { OxianConfig } from "../config/types.ts";
import type { FileRouter } from "../router/types.ts";

export const CLI_COMMANDS: readonly [
  "init",
  "dev",
  "start",
  "worker",
  "routes",
  "check",
] = Object.freeze(
  [
    "init",
    "dev",
    "start",
    "worker",
    "routes",
    "check",
  ] as const,
);

export type CliCommand = (typeof CLI_COMMANDS)[number];

export type ParsedCli = Readonly<{
  command: CliCommand;
  help: boolean;
  config?: string;
  force?: boolean;
  hostname?: string;
  manifest?: string;
  port?: number;
  root?: string;
}>;

export type CliInputError =
  & Error
  & Readonly<{ cliInputError: true }>;

export type CliIo = Readonly<{
  stdout(message: string): void;
  stderr(message: string): void;
}>;

export type CliWaitContext = Readonly<{
  command: "start" | "dev" | "worker";
}>;

export type CliDependencies = Readonly<{
  cwd?: () => string;
  io?: Partial<CliIo>;
  loadConfig?: (source: string | URL) => Promise<OxianConfig>;
  createRouter?: (
    options: Readonly<{ root: string | URL }>,
  ) => Promise<FileRouter<unknown>>;
  loadApplicationFactory?:
    typeof import("../app/factory.ts").loadApplicationFactory;
  createLocalRuntime?: (
    options: Parameters<
      typeof import("../local/runtime.ts").createLocalRuntime
    >[0],
  ) => LocalRuntime;
  loadWorkerManifest?: (
    source: string | URL,
  ) => Promise<WorkerManifest>;
  createManifestWorkerRuntime?: (
    options: Readonly<{ manifest: WorkerManifest }>,
  ) => ManifestWorkerRuntime;
  waitForLifecycle?: (
    lifecycle: LocalRuntime | ManifestWorkerRuntime,
    context: CliWaitContext,
  ) => Promise<void>;
}>;
