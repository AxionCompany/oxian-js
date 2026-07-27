# CLI API and executable

[← API reference](../api-reference.md)

Oxian publishes two related subpaths:

- `/cli` is a library. It parses or runs one invocation and returns values; it
  never calls `Deno.exit()` or installs process signal handlers.
- `/bin` is the executable entrypoint. It runs the library against `Deno.args`,
  owns `SIGINT`/`SIGTERM`, and assigns `Deno.exitCode`.

```ts
import { parseCliArgs, runCli } from "jsr:@oxian/oxian-js@0.20.0-rc.1/cli";
```

## Exports

| Kind              | Public exports from `/cli`                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Runtime values    | `CLI_USAGE`, `isCliInputError`, `parseCliArgs`, `runCli`                                                 |
| Type-only surface | `CLI_COMMANDS`, `CliCommand`, `ParsedCli`, `CliInputError`, `CliIo`, `CliWaitContext`, `CliDependencies` |

`/bin` is an executable module, not an additional import API.

## Command vocabulary

### `CLI_COMMANDS` and `CliCommand`

```ts
import type { CLI_COMMANDS } from "jsr:@oxian/oxian-js@0.20.0-rc.1/cli";

type CliCommandsTuple = typeof CLI_COMMANDS;
// readonly [
//   "init",
//   "dev",
//   "start",
//   "worker",
//   "routes",
//   "check",
// ]

type CliCommand =
  | "init"
  | "dev"
  | "start"
  | "worker"
  | "routes"
  | "check";
```

`CLI_COMMANDS` is declared as a frozen tuple in the parser's source module, but
`/cli` re-exports that declaration through `export type *`. It is therefore
available only to type queries such as the one above; it is not a property of
the runtime `/cli` module. `CliCommand` is its element union and is the complete
0.20 command set. Legacy commands, aliases, and flags are deliberately not
accepted.

### `CLI_USAGE`

`CLI_USAGE` is the complete help string:

```text
Oxian 0.20

Usage:
  oxian init [--root PATH] [--force]
  oxian dev [--config FILE] [--hostname HOST] [--port PORT]
  oxian start [--config FILE] [--hostname HOST] [--port PORT]
  oxian worker [--manifest FILE]
  oxian routes [--config FILE]
  oxian check [--config FILE]

Commands:
  init     Write a minimal oxian.config.ts and routes/index.ts
  dev      Run the local HTTP gateway and worker over WebSocket with dev edges
  start    Run the local HTTP gateway and worker over WebSocket
  worker   Attach a manifest-defined HTTP worker to a WebSocket gateway
  routes   Compile and print the immutable route table
  check    Strictly validate config, application entry, and all routes

Options:
  -h, --help  Show this help
```

Its TypeScript value is exported as a string literal constant.

## Parser

### Types

```ts
type ParsedCli = Readonly<{
  command: CliCommand;
  help: boolean;
  config?: string;
  force?: boolean;
  hostname?: string;
  manifest?: string;
  port?: number;
  root?: string;
}>;

type CliInputError =
  & Error
  & Readonly<{
    cliInputError: true;
  }>;
```

The `cliInputError` marker is non-enumerable. Use the exported guard rather than
checking it directly:

```ts
function isCliInputError(value: unknown): value is CliInputError;
```

### `parseCliArgs`

```ts
function parseCliArgs(args: readonly string[]): ParsedCli;
```

Parsing is synchronous and side-effect free: it reads no environment,
filesystem, or process state. The returned object is frozen.

Grammar rules:

- The first token must be a command, except global `-h` or `--help`.
- All commands accept `-h` and `--help`.
- String flags accept `--name value` or `--name=value`.
- Boolean flags accept no value.
- Duplicate flags, positional arguments, a bare `--`, missing values, unknown
  commands, and command-inappropriate flags throw `CliInputError`.
- Global help must be the only token. Internally it parses to
  `{ command: "start", help: true }`; callers should treat `help` as
  authoritative and not execute the command.

Command-specific flags:

| Command  | Flags                                             |
| -------- | ------------------------------------------------- |
| `init`   | `--root PATH`, `--force`                          |
| `dev`    | `--config FILE`, `--hostname HOST`, `--port PORT` |
| `start`  | `--config FILE`, `--hostname HOST`, `--port PORT` |
| `worker` | `--manifest FILE`                                 |
| `routes` | `--config FILE`                                   |
| `check`  | `--config FILE`                                   |

Value validation:

- `--port` is canonical unsigned decimal from `0` through `65535`; signs and
  leading zeroes such as `01` are rejected.
- `--hostname` is a non-empty bare hostname or IP address, not a URL, authority
  with credentials, or string containing path/query/fragment delimiters.
- `--config` and `--manifest` name a local `.ts` path or `file:` URL without
  query or fragment. Network URLs and other extensions are rejected.
- `--root` is a non-empty local directory path, not a URL.
- Null characters are rejected in path-like values.

## Programmatic runner

### I/O and lifecycle types

```ts
type CliIo = Readonly<{
  stdout(message: string): void;
  stderr(message: string): void;
}>;

type CliWaitContext = Readonly<{
  command: "start" | "dev" | "worker";
}>;
```

`CliDependencies` exposes the runner's effectful boundaries for embedding and
tests:

```ts
type CliDependencies = Readonly<{
  cwd?: () => string;
  io?: Partial<CliIo>;
  loadConfig?: (
    source: string | URL,
  ) => Promise<OxianConfig>;
  createRouter?: (
    options: Readonly<{ root: string | URL }>,
  ) => Promise<FileRouter<unknown>>;
  loadApplicationFactory?: typeof loadApplicationFactory;
  createLocalRuntime?: (
    options: LocalRuntimeOptions,
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
```

Omitted dependencies use the corresponding Oxian implementation. `cwd` defaults
to `Deno.cwd`. Missing `stdout` or `stderr` methods default independently to
`console.log` or `console.error`. `waitForLifecycle` defaults to awaiting
`lifecycle.finished`; embedders may replace it with their own shutdown policy
without transferring signal ownership to the library.

### `runCli`

```ts
function runCli(
  args: readonly string[],
  dependencies?: CliDependencies,
): Promise<number>;
```

`runCli` parses, executes, writes user-facing output, and resolves to a process
exit code:

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| `0`  | Help or command completed successfully                                          |
| `1`  | Configuration, filesystem, application, runtime, or injected dependency failure |
| `2`  | Invalid CLI input                                                               |

Invalid input writes `error: …`, a blank line, and `CLI_USAGE` to stderr.
Command failures write `error: …` to stderr. Help writes `CLI_USAGE` to stdout
without loading configuration or running a command. `runCli` catches command
failures into code `1`; it does not throw them. Errors not identified as parser
input errors during the parsing phase are allowed to propagate.

The library runner does not set `Deno.exitCode`, call `Deno.exit`, add signal
listeners, or decide when an embedding process should terminate.

## Command behavior

### `init`

```text
oxian init [--root PATH] [--force]
```

The root defaults to the current directory. The command creates
`oxian.config.ts` and `routes/index.ts`; the minimal configuration listens on
`127.0.0.1:8000`, mounts `./routes` at `/`, and the route responds with a JSON
hello message. It refuses to overwrite either existing file unless `--force` is
present. Success prints `initialized ABSOLUTE_ROOT`.

### `dev` and `start`

```text
oxian dev [--config FILE] [--hostname HOST] [--port PORT]
oxian start [--config FILE] [--hostname HOST] [--port PORT]
```

The configuration defaults to `oxian.config.ts` relative to the injected working
directory. Hostname and port override its listener for this invocation. Both
create and start a `LocalRuntime`; `dev` selects runtime mode `"dev"` so
configured development proxy edges are active. Once ready, the command prints
`Oxian COMMAND listening at URL`, awaits `waitForLifecycle`, and always stops
the runtime in a `finally` block with reason `"cli_server_command_complete"`.

### `worker`

```text
oxian worker [--manifest FILE]
```

The manifest defaults to `oxian.worker.ts` relative to the working directory.
The command loads it, creates a `ManifestWorkerRuntime`, and waits until its
worker is ready before printing `Oxian worker WORKER_ID is ready`. It then
awaits `waitForLifecycle` and always stops the runtime with reason
`"cli_worker_command_complete"`.

### `routes`

```text
oxian routes [--config FILE]
```

The command strictly loads configuration and compiles the same immutable file
router used by the application. It prints one line per route with sorted methods
and route pattern, or `no routes`.

### `check`

```text
oxian check [--config FILE]
```

The command strictly validates configuration, compiles every route, and, when
configured, imports and validates the application-factory module. It does not
invoke the factory or application setup. Success reports the validated route
count.

## Executable /bin

Run the executable entrypoint with the Deno permissions required by the chosen
command:

```sh
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin --help
deno run -A jsr:@oxian/oxian-js@0.20.0-rc.1/bin start
```

At module evaluation, `/bin` calls:

```ts
Deno.exitCode = await runCli(Deno.args, {
  waitForLifecycle: waitForSignalOrFinish,
});
```

For `start`, `dev`, and `worker`, `waitForSignalOrFinish` installs listeners for
both `SIGINT` and `SIGTERM`, then races the lifecycle's `finished` promise
against the first signal. It removes both listeners in `finally`. Returning from
that wait lets the command's own `finally` stop and dispose its runtime before
`runCli` returns.

This is the only exported entrypoint that owns signals and process exit status.
Import `/cli`, not `/bin`, when another server, test runner, desktop shell, or
service manager already owns those policies.
