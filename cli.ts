import { runCli } from "./src/cli/index.ts";
import type { CliWaitContext } from "./src/cli/types.ts";
import type { LocalRuntime, ManifestWorkerRuntime } from "./src/local/types.ts";

type CliLifecycle = LocalRuntime | ManifestWorkerRuntime;

async function waitForSignalOrFinish(
  lifecycle: CliLifecycle,
  _context: CliWaitContext,
): Promise<void> {
  const signals = ["SIGINT", "SIGTERM"] as const;
  let resolveSignal: (() => void) | undefined;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const listener = (): void => resolveSignal?.();

  for (const name of signals) Deno.addSignalListener(name, listener);
  try {
    await Promise.race([lifecycle.finished, signal]);
  } finally {
    for (const name of signals) Deno.removeSignalListener(name, listener);
  }
}

Deno.exitCode = await runCli(Deno.args, {
  waitForLifecycle: waitForSignalOrFinish,
});
