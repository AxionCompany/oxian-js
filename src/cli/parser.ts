import {
  CLI_COMMANDS,
  type CliCommand,
  type CliInputError,
  type ParsedCli,
} from "./types.ts";

type FlagKind = "boolean" | "string";

const FLAGS: Readonly<
  Record<CliCommand, Readonly<Record<string, FlagKind>>>
> = Object.freeze({
  init: Object.freeze({
    help: "boolean",
    force: "boolean",
    root: "string",
  }),
  dev: Object.freeze({
    help: "boolean",
    config: "string",
    hostname: "string",
    port: "string",
  }),
  start: Object.freeze({
    help: "boolean",
    config: "string",
    hostname: "string",
    port: "string",
  }),
  worker: Object.freeze({
    help: "boolean",
    manifest: "string",
  }),
  routes: Object.freeze({
    help: "boolean",
    config: "string",
  }),
  check: Object.freeze({
    help: "boolean",
    config: "string",
  }),
});

function inputError(message: string): CliInputError {
  const error = new Error(message) as CliInputError;
  Object.defineProperty(error, "cliInputError", {
    enumerable: false,
    value: true,
  });
  return error;
}

export function isCliInputError(
  value: unknown,
): value is CliInputError {
  return value instanceof Error &&
    (value as Partial<CliInputError>).cliInputError === true;
}

function isCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

function parsePort(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw inputError("--port must be an integer between 0 and 65535");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw inputError("--port must be an integer between 0 and 65535");
  }
  return port;
}

function parseHostname(value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("@")
  ) {
    throw inputError("--hostname must be a bare hostname or IP address");
  }
  try {
    const authority = value.includes(":") ? `[${value}]` : value;
    if (new URL(`http://${authority}/`).hostname.length === 0) {
      throw new Error("empty hostname");
    }
  } catch {
    throw inputError("--hostname must be a bare hostname or IP address");
  }
  return value;
}

function parseModulePath(value: string, flag: string): string {
  if (value.length === 0 || value.includes("\0")) {
    throw inputError(`${flag} must name a local .ts module`);
  }
  if (
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
  ) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw inputError(`${flag} must name a local .ts module`);
    }
    if (
      url.protocol !== "file:" ||
      url.search !== "" ||
      url.hash !== "" ||
      !url.pathname.endsWith(".ts")
    ) {
      throw inputError(`${flag} must name a local .ts module`);
    }
    return value;
  }
  if (!value.endsWith(".ts")) {
    throw inputError(`${flag} must name a local .ts module`);
  }
  return value;
}

function parseRoot(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    (
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    )
  ) {
    throw inputError("--root must be a local directory path");
  }
  return value;
}

function normalizedValue(name: string, value: string): string | number {
  if (name === "port") return parsePort(value);
  if (name === "hostname") return parseHostname(value);
  if (name === "config") return parseModulePath(value, "--config");
  if (name === "manifest") return parseModulePath(value, "--manifest");
  if (name === "root") return parseRoot(value);
  return value;
}

/**
 * Parses exactly the 0.20 command vocabulary. It deliberately performs no
 * environment reads and does not inherit the legacy CLI's aliases or flags.
 */
export function parseCliArgs(args: readonly string[]): ParsedCli {
  if (!Array.isArray(args)) {
    throw inputError("CLI arguments must be an array");
  }
  const commandToken = args[0];
  if (commandToken === undefined) {
    throw inputError(
      `missing command (expected ${CLI_COMMANDS.join(", ")})`,
    );
  }
  if (commandToken === "--help" || commandToken === "-h") {
    if (args.length !== 1) {
      throw inputError("global --help does not accept additional arguments");
    }
    return Object.freeze({ command: "start", help: true });
  }
  if (!isCommand(commandToken)) {
    throw inputError(`unknown command "${commandToken}"`);
  }

  const permitted = FLAGS[commandToken];
  const values: Record<string, string | number | boolean> = {};
  for (let index = 1; index < args.length; index++) {
    const token = args[index];
    if (token === "-h") {
      if (values.help !== undefined) {
        throw inputError("duplicate flag --help");
      }
      values.help = true;
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      throw inputError(`unexpected positional argument "${token}"`);
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (name.length === 0 || !Object.hasOwn(permitted, name)) {
      throw inputError(`unknown flag "--${name}" for ${commandToken}`);
    }
    if (values[name] !== undefined) {
      throw inputError(`duplicate flag --${name}`);
    }
    const kind = permitted[name];
    if (kind === "boolean") {
      if (equals !== -1) {
        throw inputError(`--${name} does not accept a value`);
      }
      values[name] = true;
      continue;
    }

    let raw: string;
    if (equals !== -1) {
      raw = token.slice(equals + 1);
    } else {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw inputError(`--${name} requires a value`);
      }
      raw = next;
      index++;
    }
    if (raw.length === 0) {
      throw inputError(`--${name} requires a non-empty value`);
    }
    values[name] = normalizedValue(name, raw);
  }

  return Object.freeze({
    command: commandToken,
    help: values.help === true,
    ...(values.config === undefined ? {} : { config: values.config as string }),
    ...(values.force === undefined ? {} : { force: true }),
    ...(values.hostname === undefined
      ? {}
      : { hostname: values.hostname as string }),
    ...(values.manifest === undefined
      ? {}
      : { manifest: values.manifest as string }),
    ...(values.port === undefined ? {} : { port: values.port as number }),
    ...(values.root === undefined ? {} : { root: values.root as string }),
  });
}
